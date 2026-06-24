import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "./protocol";
import type { SocketData } from "./room";
import {
  join, leave, broadcast, dm, sendError, isNameTaken, getNames,
  createChannel, joinChannel, leaveChannel, channelMessage, readChannel, listChannels, getChannelsList,
  hydrateChannels,
} from "./room";
import { seedFromJson } from "./history";

const PORT = parseInt(process.env.PORT || "8080");

const server = Bun.serve<SocketData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { name: "" } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // HTTP: list agents (convenience)
    if (url.pathname === "/agents") {
      const names = getNames();
      return Response.json({ agents: names });
    }

    // HTTP: list channels
    if (url.pathname === "/channels") {
      return Response.json({ channels: getChannelsList() });
    }

    // HTTP: homepage — serve the chat UI
    return new Response(Bun.file(new URL("./ui.html", import.meta.url)));
  },

  websocket: {
    open(ws) {
      // Connection opened — client must send "join" message next
    },

    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      } catch {
        sendError(ws, "Invalid JSON");
        return;
      }

      switch (msg.type) {
        case "join": {
          const name = msg.name?.trim();
          if (!name) {
            sendError(ws, "Name is required");
            return;
          }
          if (isNameTaken(name)) {
            sendError(ws, `Name "${name}" is already taken`);
            return;
          }
          await join(name, ws);
          console.log(`${name} joined (${getNames().length} online)`);
          break;
        }

        case "message": {
          if (!ws.data.name) {
            sendError(ws, "Must join first (send {type:'join', name:'...'})");
            return;
          }
          if (!msg.text?.trim()) {
            sendError(ws, "Empty message");
            return;
          }
          await broadcast(ws.data.name, msg.text.trim());
          break;
        }

        case "dm": {
          if (!ws.data.name) {
            sendError(ws, "Must join first");
            return;
          }
          if (!msg.to?.trim() || !msg.text?.trim()) {
            sendError(ws, "DM requires 'to' and 'text'");
            return;
          }
          const delivered = await dm(ws.data.name, msg.to.trim(), msg.text.trim());
          if (!delivered) {
            sendError(ws, `"${msg.to}" is offline — message saved for when they reconnect`);
          }
          break;
        }

        case "create_channel": {
          if (!ws.data.name) { sendError(ws, "Must join first"); return; }
          if (!msg.channel?.trim()) { sendError(ws, "Channel name required"); return; }
          await createChannel(msg.channel.trim().toLowerCase(), ws.data.name, ws);
          console.log(`#${msg.channel} created by ${ws.data.name}`);
          break;
        }

        case "join_channel": {
          if (!ws.data.name) { sendError(ws, "Must join first"); return; }
          await joinChannel(msg.channel, ws.data.name, ws);
          break;
        }

        case "leave_channel": {
          if (!ws.data.name) { sendError(ws, "Must join first"); return; }
          await leaveChannel(msg.channel, ws.data.name, ws);
          break;
        }

        case "channel_message": {
          if (!ws.data.name) { sendError(ws, "Must join first"); return; }
          if (!msg.text?.trim()) { sendError(ws, "Empty message"); return; }
          await channelMessage(msg.channel, ws.data.name, msg.text.trim());
          break;
        }

        case "read_channel": {
          if (!ws.data.name) { sendError(ws, "Must join first"); return; }
          await readChannel(msg.channel, ws.data.name, ws);
          break;
        }

        case "list_channels": {
          if (!ws.data.name) { sendError(ws, "Must join first"); return; }
          listChannels(ws);
          break;
        }

        default:
          sendError(ws, `Unknown message type: ${(msg as any).type}`);
      }
    },

    close(ws) {
      if (ws.data.name) {
        console.log(`${ws.data.name} left`);
        leave(ws);
      }
    },
  },
});

// Startup: seed from chat-history.json (if needed) then hydrate channels from DB.
seedFromJson()
  .then(() => hydrateChannels())
  .then(() => {
    console.log(`Agent Chat server running on http://localhost:${server.port}`);
    console.log(`WebSocket endpoint: ws://localhost:${server.port}/ws`);
  })
  .catch((err) => {
    console.error("Startup failed:", err.message?.replace(/postgres:\/\/[^\s]+/g, "postgres://<redacted>"));
    process.exit(1);
  });
