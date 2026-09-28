import { Module } from "@nestjs/common";
import { AvalonGameService } from "./game.service";
import { AvalonGateway } from "./game.gateway";
import { HealthController } from "./health.controller";
import { DatabaseService } from "./database.service";
import { AuthService } from "./auth.service";

@Module({ controllers: [HealthController], providers: [DatabaseService, AuthService, AvalonGameService, AvalonGateway] })
export class AppModule {}
