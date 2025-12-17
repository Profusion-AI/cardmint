/**
 * Debug script for EverShop database inspection.
 * Requires environment variables or ~/.ssh/cardmint_droplet key.
 *
 * Environment:
 *   EVERSHOP_SSH_HOST - Production server IP/hostname
 *   EVERSHOP_SSH_USER - SSH user (default: cardmint)
 *   EVERSHOP_SSH_KEY  - Path to SSH key (default: ~/.ssh/cardmint_droplet)
 *   EVERSHOP_DOCKER_PATH - Path to docker-compose.yml (default: /opt/cardmint/docker-compose.yml)
 */
import { execSync } from "child_process";
import path from "path";
import os from "os";

// Read from environment or use safe defaults for local development
const sshKey = process.env.EVERSHOP_SSH_KEY ?? path.resolve(os.homedir(), ".ssh/cardmint_droplet");
const sshUser = process.env.EVERSHOP_SSH_USER ?? "cardmint";
const sshHost = process.env.EVERSHOP_SSH_HOST;
const dockerPath = process.env.EVERSHOP_DOCKER_PATH ?? "/opt/cardmint/docker-compose.yml";
const dbUser = "evershop";
const dbName = "evershop";

if (!sshHost) {
    console.error("ERROR: EVERSHOP_SSH_HOST environment variable is required.");
    console.error("Set it to the production server IP before running this script.");
    console.error("Example: EVERSHOP_SSH_HOST=your.server.ip npx tsx scripts/debug_evershop.ts");
    process.exit(1);
}

function executeSshSql(sql: string) {
    const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
    const command = `ssh -i ${sshKey} -o StrictHostKeyChecking=no ${sshUser}@${sshHost} "echo ${sqlBase64} | base64 -d | docker compose -f ${dockerPath} exec -T database psql -U ${dbUser} -d ${dbName} -t"`;

    console.log(`Executing SQL: ${sql}`);
    try {
        const result = execSync(command, { encoding: "utf-8", timeout: 30000 });
        return result.trim();
    } catch (error: any) {
        console.error("SSH execution failed:", error.message);
        if (error.stderr) console.error("Stderr:", error.stderr.toString());
        return null;
    }
}

const countVisible = executeSshSql("SELECT count(*) FROM product WHERE visibility = true;");
console.log("Visible products count:", countVisible);

const countTotal = executeSshSql("SELECT count(*) FROM product;");
console.log("Total products count:", countTotal);

const visibleSkus = executeSshSql("SELECT sku FROM product WHERE visibility = true;");
console.log("Visible SKUs:", visibleSkus);
