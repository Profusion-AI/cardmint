import { parseArgs } from "node:util";
import { openDatabase } from "../src/db/connection";
import { runtimeConfig } from "../src/config";
import { EverShopImporter } from "../src/services/importer/evershopClient";
import pino from "pino";
import path from "node:path";

const logger = pino({
    level: "info",
});

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            "dry-run": { type: "boolean", default: false },
            confirm: { type: "boolean", default: false },
            "export-csv": { type: "boolean", default: false },
            limit: { type: "string", default: "6" },
        },
    });

    const dryRun = values["dry-run"] || !values.confirm;
    const exportCSV = values["export-csv"];
    const limit = parseInt(values.limit || "6", 10);

    logger.info({ dryRun, exportCSV, limit }, "Starting import pilot");

    const db = openDatabase();
    const config = {
        apiUrl: process.env.EVERSHOP_API_URL || "http://localhost:3000/api",
        adminToken: process.env.EVERSHOP_ADMIN_TOKEN || "placeholder",
        environment: (process.env.NODE_ENV as any) || "development",
    };

    const importer = new EverShopImporter(db, config, logger);

    if (exportCSV) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outputPath = path.resolve(
            process.cwd(),
            `exports/evershop/evershop-import-${timestamp}.csv`,
        );
        await importer.exportToCSV(limit, outputPath);
    } else {
        await importer.runImport(limit, dryRun);
    }
}

main().catch((err) => {
    logger.error(err);
    process.exit(1);
});
