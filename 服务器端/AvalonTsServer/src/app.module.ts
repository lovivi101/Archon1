import { Module } from "@nestjs/common";
import { AvalonGameService } from "./game.service";
import { AvalonGateway } from "./game.gateway";
import { HealthController } from "./health.controller";
import { DatabaseService } from "./database.service";

@Module({ controllers: [HealthController], providers: [DatabaseService, AvalonGameService, AvalonGateway] })
export class AppModule {}
