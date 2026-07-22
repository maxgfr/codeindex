import { lib } from "@x/lib";
import { helper } from "@x/lib/utils";
import { auth } from "@x/lib/features/auth";

export const run = () => `${lib}:${helper()}:${auth()}`;
