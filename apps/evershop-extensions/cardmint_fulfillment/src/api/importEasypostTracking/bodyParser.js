/**
 * Body parser middleware for EasyPost tracking CSV import
 *
 * EverShop does not include JSON body parsing by default for API routes.
 * This middleware parses JSON request bodies up to 25MB (for large CSV exports).
 */

import bodyParser from "body-parser";

export default (request, response, next) => {
  bodyParser.json({ limit: "25mb" })(request, response, next);
};
