import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "./protocol";
import type { SocketData } from "./room";
import {
  join, leave, broadcast, dm, sendError, isNameTaken, getNames,
  createChannel, joinChannel, leaveChannel, channelMessage, readChannel, listChannels, getChannelsList,
  hydrateChannels, getSocket, sendTo,
} from "./room";
import { seedFromJson } from "./history";
import {
  createAgent, bootstrapAgent, validateAccessToken, setStatus, listAgents, findAgent, AgentError,
} from "./agents";

const PORT = parseInt(process.env.PORT || "8080");

const server = Bun.serve<SocketData>({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // ── WebSocket upgrade ──────────────────────────────
    if (path === "/ws" && method === "GET") {
      const upgraded = server.upgrade(req, { data: { name: "" } });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // ── REST API: /api/* ───────────────────────────────
    if (path.startsWith("/api/")) {
      return handleApi(req, method, path, url).catch((err) => {
        const msg = err instanceof AgentError
          ? err.message
          : err.message?.replace(/postgres:\/\/[^\s]+/g, "postgres://<redacted>") ?? "Internal error";
        const status = err instanceof AgentError ? 400 : 500;
        return Response.json({ error: msg }, { status });
      });
    }

    // ── Legacy convenience endpoints ───────────────────
    if (path === "/agents" && method === "GET") {
      const names = getNames();
      return Response.json({ agents: names });
    }

    if (path === "/channels" && method === "GET") {
      return Response.json({ channels: getChannelsList() });
    }

    // ── Homepage ───────────────────────────────────────
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

          // If this name is a registered agent, require a valid access token.
          const agent = await findAgent(name);
          if (agent) {
            const token = (msg as { token?: string }).token;
            if (!token) {
              sendError(ws, `Agent "${name}" requires an access token`);
              return;
            }
            const valid = await validateAccessToken(name, token);
            if (!valid) {
              sendError(ws, "Invalid or expired access token");
              return;
            }
          }

          await join(name, ws);

          // Update agent status if registered
          if (agent) {
            await setStatus(name, "online");
          }

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
      const name = ws.data.name;
      if (name) {
        console.log(`${name} left`);
        leave(ws);
        // If this was a registered agent, mark offline (fire-and-forget)
        findAgent(name).then((agent) => {
          if (agent) setStatus(name, "offline");
        });
      }
    },
  },
});

// ── REST API router ───────────────────────────────────

async function handleApi(
  req: Request,
  method: string,
  path: string,
  url: URL
): Promise<Response> {
  const host = req.headers.get("host") || `localhost:${PORT}`;

  // POST /api/agents — create a new agent
  if (path === "/api/agents" && method === "POST") {
    const body = await req.json();
    if (!body.description?.trim()) {
      return Response.json({ error: "description is required" }, { status: 400 });
    }
    const result = await createAgent({
      description: body.description,
      name: body.name,
      provider: body.provider,
      model: body.model,
    });
    return Response.json(result, { status: 201 });
  }

  // GET /api/agents — list the registry
  if (path === "/api/agents" && method === "GET") {
    const agents = await listAgents();
    return Response.json(agents);
  }

  // POST /api/agents/bootstrap — exchange a bootstrap token for credentials
  if (path === "/api/agents/bootstrap" && method === "POST") {
    const body = await req.json();
    if (!body.token) {
      return Response.json({ error: "token is required" }, { status: 400 });
    }
    try {
      const result = await bootstrapAgent(body.token, host);
      return Response.json(result, { status: 200 });
    } catch (err) {
      if (err instanceof AgentError) {
        const status = err.code === "missing_key" ? 503 : 401;
        return Response.json({ error: err.message, code: err.code }, { status });
      }
      throw err;
    }
  }

  // POST /api/agents/:name/stop — send a shutdown message to a live agent
  const stopMatch = path.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopMatch && method === "POST") {
    const name = stopMatch[1];
    const agent = await findAgent(name);
    if (!agent) {
      return Response.json({ error: `Agent "${name}" not found` }, { status: 404 });
    }
    // Send shutdown over the live WS if connected
    const sent = sendTo(name, { type: "shutdown" });
    const ws = getSocket(name);
    if (ws) ws.close();
    await setStatus(name, "stopped");
    return Response.json({ ok: true, name, wsDelivered: sent });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

// ── Startup ───────────────────────────────────────────

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
