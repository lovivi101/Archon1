import { ConsoleLogger, Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
    const port = Number(process.env.PORT ?? 8888);
    const app = await NestFactory.create(AppModule, {
        logger: new ConsoleLogger({ json: process.env.LOG_JSON === "1" }),
    });
    const httpLogger = new Logger("HttpAccess");
    app.use((request: Request, response: Response, next: NextFunction) => {
        const requestId = randomUUID();
        const started = Date.now();
        response.setHeader("X-Request-Id", requestId);
        response.on("finish", () => {
            if (request.path === "/health" && response.statusCode === 200) return;
            httpLogger.log({ event: "http.request", requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Date.now() - started });
        });
        next();
    });
    app.useWebSocketAdapter(new WsAdapter(app, {
        messageParser: (raw: string | Buffer | ArrayBuffer | Buffer[]) => ({ event: "packet", data: raw }),
    }));
    app.enableShutdownHooks();
    await app.listen(port, "0.0.0.0");
    Logger.log(`HTTP /health and WebSocket listening on :${port}`, "AvalonTsServer");
}

bootstrap().catch((error: unknown) => {
    Logger.error(String(error), undefined, "AvalonTsServer");
    process.exitCode = 1;
});
