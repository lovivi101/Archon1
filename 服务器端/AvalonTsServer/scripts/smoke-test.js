const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

require("ts-node").register({ transpileOnly: true, compilerOptions: { module: "CommonJS", moduleResolution: "Node" } });
global.WebSocket = WebSocket;
const { AvalonNetwork } = require(path.resolve(__dirname, "../../../客户端/Cocos_Client/assets/Scripts/Network/AvalonNetwork.ts"));

const userId = String(900000 + Math.floor(Math.random() * 99999));
const receivedRoutes = [];
let server;
const network = AvalonNetwork.instance;
let timeout;
let completed = false;

function send(route, payload) {
    if (!network.send(route, payload)) throw new Error(`Client could not send route ${route}: ${network.lastMessage}`);
}

function finish(code, message) {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    if (message) console.log(message);
    network.close();
    server?.kill();
    process.exitCode = code;
}

async function findPort() {
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

async function waitForHealth(port) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const result = await fetch(`http://127.0.0.1:${port}/health`);
            const data = await result.json();
            if (result.ok && data.ok && data.room.stage === 0) return;
        } catch (_) {
            // The isolated server may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Isolated server did not become healthy.");
}

async function main() {
    const port = await findPort();
    server = spawn(process.execPath, [path.join(__dirname, "../dist/server.js")], {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, PORT: String(port), AVALON_NIGHT_SECONDS: "1" },
        stdio: "ignore",
        windowsHide: true,
    });
    server.on("error", (error) => finish(1, `Server start error: ${error.message}`));
    await waitForHealth(port);

    timeout = setTimeout(() => finish(1, `WebSocket smoke test timed out. Routes: ${receivedRoutes.join(",")}`), 8000);
    network.onStatus((state, message) => {
        if (state === "open") send(101, { userId, nickname: "SmokeTester" });
        if (state === "error") finish(1, `Client network error: ${message}`);
    });
    const handle = (route, payload) => {
        try {
            receivedRoutes.push(route);
            console.log(`route=${route} payload=${JSON.stringify(payload).slice(0, 180)}`);
            if (payload.code !== undefined && payload.code !== 0) {
                throw new Error(`Route ${route} failed: ${payload.code} ${payload.message || ""}`);
            }
            if (route === 101) {
                send(102, { roomId: "888", userId, nickname: "SmokeTester" });
            } else if (route === 102) {
                send(103, { userId });
            } else if (route === 302 && receivedRoutes.includes(301) && receivedRoutes.includes(303)) {
                finish(0, `PASS routes=${receivedRoutes.join(",")}`);
            }
        } catch (error) {
            finish(1, error.message);
        }
    };
    for (const route of [101, 102, 201, 202, 301, 302, 303]) {
        network.registerHandler(route, (payload) => handle(route, payload));
    }
    network.connect(`ws://127.0.0.1:${port}`);
}

main().catch((error) => finish(1, error.message));
