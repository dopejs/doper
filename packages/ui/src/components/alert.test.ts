import { afterEach, describe, expect, it } from "vitest";

import { setTheme } from "../theme";
import { Alert, type AlertProps } from "./alert";

afterEach(() => setTheme("light"));

type Host = { type: unknown; props: Record<string, unknown> };

function render(props: AlertProps) {
  // Components evaluate to host descriptors without a root.
  return Alert.component(props) as Host;
}

describe("Alert", () => {
  it("composes default classes on shell, title, and description", () => {
    const node = render({ title: "Heads up", children: "Something happened" });
    expect(node.props.className).toBe("pui-alert");
    const [title, description] = node.props.children as [Host, Host];
    expect(title.props.className).toBe("pui-alert__title");
    expect(title.props.value).toBe("Heads up");
    expect(description.props.className).toBe("pui-alert__description");
    expect(description.props.value).toBe("Something happened");
  });

  it("destructive variant marks the shell and the title", () => {
    const node = render({ title: "Error", children: "Broke", variant: "destructive" });
    expect(node.props.className).toBe("pui-alert pui-alert--destructive");
    const [title, description] = node.props.children as [Host, Host];
    expect(title.props.className).toBe("pui-alert__title pui-alert__title--destructive");
    expect(description.props.className).toBe("pui-alert__description");
  });

  it("appends dark markers from the theme signal", () => {
    setTheme("dark");
    const node = render({ title: "t", children: "d", variant: "destructive" });
    expect(node.props.className).toBe("pui-alert pui-alert--destructive pui-dark");
    const [title, description] = node.props.children as [Host, Host];
    expect(title.props.className).toBe("pui-alert__title pui-alert__title--destructive pui-dark");
    expect(description.props.className).toBe("pui-alert__description pui-dark");
  });

  it("appends user className last on the shell", () => {
    const node = render({ title: "t", children: "d", className: "mine" });
    expect(node.props.className).toBe("pui-alert mine");
  });
});
