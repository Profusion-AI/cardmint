import { createLogger } from "../src/app/context";
import { runtimeConfig } from "../src/config";
import { openDatabase } from "../src/db/connection";
import { EverShopImporter } from "../src/services/importer/evershopClient";
import type { EverShopConfig } from "../src/services/importer/types";

async function main() {
  const logger = createLogger();
  const db = openDatabase();

  const evershopConfig: EverShopConfig = {
    apiUrl: runtimeConfig.evershopApiUrl,
    adminToken: runtimeConfig.evershopAdminToken,
    environment: runtimeConfig.evershopEnvironment as "staging" | "production",
    sshKeyPath: runtimeConfig.evershopSshKeyPath,
    sshUser: runtimeConfig.evershopSshUser,
    sshHost: runtimeConfig.evershopSshHost,
    dockerComposePath: runtimeConfig.evershopDockerComposePath,
    dbUser: runtimeConfig.evershopDbUser,
    dbName: runtimeConfig.evershopDbName,
  };

  const importer = new EverShopImporter(db, evershopConfig, logger);

  // Run with limit 0 and dryRun=true to only sync categories without touching products
  await importer.runImport(0, true);
  logger.info("EverShop category sync complete (dry-run import triggered)");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("EverShop category sync failed", error);
  process.exit(1);
});
