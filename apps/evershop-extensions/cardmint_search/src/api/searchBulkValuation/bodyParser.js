import bodyParser from "body-parser";

export default (request, response, next) => {
  bodyParser.json({ limit: "10mb" })(request, response, next);
};
