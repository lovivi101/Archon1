import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { AvalonGameService } from "./game.service";

@Controller()
export class HealthController {
    public constructor(private readonly game: AvalonGameService) {}

    @Get("health")
    public async health(): Promise<Record<string, unknown>> {
        const status = await this.game.health(Number(process.env.PORT ?? 8888));
        if (!status.ok) throw new ServiceUnavailableException(status);
        return status;
    }
}
