import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(DatabaseService.name);
    private readonly pool?: Pool;

    public constructor() {
        if (process.env.NODE_ENV === "production" && !process.env.PGHOST) {
            throw new Error("PGHOST is required in production");
        }
        if (process.env.PGHOST) {
            this.pool = new Pool({
                connectionTimeoutMillis: 3000,
                idleTimeoutMillis: 30000,
                max: 10,
            });
            this.pool.on("error", (error) => this.logger.error(`Idle database connection error: ${error.message}`, error.stack));
        }
    }

    public async onModuleInit(): Promise<void> {
        if (!this.pool) {
            this.logger.warn("Database disabled; player profiles will not persist. Set PGHOST or use Docker Compose.");
            return;
        }
        await this.pool.query("SELECT 1");
        this.logger.log("Database connection ready");
    }

    public async onModuleDestroy(): Promise<void> {
        await this.pool?.end();
    }

    public async isReady(): Promise<boolean> {
        if (!this.pool) return process.env.NODE_ENV !== "production";
        try {
            await this.pool.query("SELECT 1");
            return true;
        } catch (error) {
            this.logger.error(`Database health check failed: ${String(error)}`);
            return false;
        }
    }

    public get enabled(): boolean {
        return Boolean(this.pool);
    }

    public async saveProfile(userId: string, nickname: string): Promise<void> {
        if (!this.pool) return;
        await this.pool.query(
            `INSERT INTO player_profiles (user_id, nickname) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET nickname = EXCLUDED.nickname, updated_at = NOW()`,
            [userId, nickname],
        );
    }
}
