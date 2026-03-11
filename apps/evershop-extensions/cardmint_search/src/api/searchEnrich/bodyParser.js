import bodyParser from "body-parser";

export default (request, response, next) => {
  bodyParser.json({ limit: "1mb" })(request, response, next);
};
