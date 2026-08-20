import type { Demo } from "../demo";
import { editingDemo } from "./editing";
import { eventsDemo } from "./events";
import { scrollDemo } from "./scroll";
import { semanticsDemo } from "./semantics";
import { transportDemo } from "./transport";

export const demos: readonly Demo[] = [
  scrollDemo,
  editingDemo,
  eventsDemo,
  semanticsDemo,
  transportDemo,
];
