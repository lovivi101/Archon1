const { createHash } = require("node:crypto");
const { readdir, readFile } = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");

async function main() {
    if (!process.env.PGHOST) throw new Error("PGHOST is required for database migrations");
    const client = new Client({ connectionTimeoutMillis: 10000 });
    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(48270401)");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        const migrationsDir = path.resolve(__dirname, "../migrations");
        const files = (await readdir(migrationsDir)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
        for (const file of files) {
            const sql = await readFile(path.join(migrationsDir, file), "utf8");
            const checksum = createHash("sha256").update(sql).digest("hex");
            const result = await client.query("SELECT checksum FROM schema_migrations WHERE name = $1", [file]);
            if (result.rowCount) {
                if (result.rows[0].checksum !== checksum) throw new Error(`Migration was modified after application: ${file}`);
                continue;
            }
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
            console.log(JSON.stringify({ event: "db.migration_applied", name: file }));
        }
        await client.query("COMMIT");
        console.log(JSON.stringify({ event: "db.migrations_ready", count: files.length }));
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        await client.end();
    }
}

main().catch((error) => {
    console.error(JSON.stringify({ event: "db.migration_failed", error: String(error) }));
    process.exitCode = 1;
});
