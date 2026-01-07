/**
 * Body parser middleware for shipment status update endpoint
 *
 * EverShop does not include JSON body parsing by default for API routes.
 */

import bodyParser from "body-parser";

export default (request, response, next) => {
  bodyParser.json({ limit: "1mb" })(request, response, next);
};
