import {answer, Client} from "@fixture/client";
import {sub} from "@fixture/client/sub";
export const value = answer();
export const fortyTwo = sub;
export function main() { return new Client().get("/items"); }
