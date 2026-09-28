import { Module } from "@nestjs/common";
import { AvalonGameService } from "./game.service";
import { AvalonGateway } from "./game.gateway";
import { HealthController } from "./health.controller";
import { DatabaseService } from "./database.service";
import { AuthService } from "./auth.service";
import { RecordsService } from "./records.service";

@Module({ controllers: [HealthController], providers: [DatabaseService, AuthService, RecordsService, AvalonGameService, AvalonGateway] })
export class AppModule {}
