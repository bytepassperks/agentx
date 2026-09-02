import { editFile, glob, grep, listDir, readFile, writeFile } from "./files";
import { github, gitPush } from "./github";
import { askUser, memorySave, todoWrite, webFetch } from "./misc";
import { shell } from "./shell";
import type { Tool } from "./types";

export const TOOLS: Tool[] = [
  shell, readFile, writeFile, editFile, listDir, glob, grep, github, gitPush, webFetch, todoWrite, memorySave, askUser,
] as Tool[];

export const toolByName = new Map(TOOLS.map((t) => [t.spec.name, t]));
export const toolSpecs = TOOLS.map((t) => t.spec);
