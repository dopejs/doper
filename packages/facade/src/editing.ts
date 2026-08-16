import { TextEditingController, type TextEditingControllerOptions } from "@dopejs/doper-editing";
import { useMemo } from "@dopejs/doper-runtime";

/** Returns one stable controller and synchronizes its external value every render. */
export function useTextEditingController(
  options: TextEditingControllerOptions,
): TextEditingController {
  const controller = useMemo(() => new TextEditingController(options), []);
  controller.synchronize(options);
  return controller;
}
