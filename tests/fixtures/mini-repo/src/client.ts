// HTTP client with retry. The core network entry point for the mini repo.
import { backoff } from "./util.js";
import { helper } from "@/helpers";

export class HttpClient {
  request(): number {
    return backoff(helper());
  }
}
