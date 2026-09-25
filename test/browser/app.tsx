import React from "react";
import { createRoot } from "react-dom/client";
import { create, Source } from "../../src/configs";
import { boolean } from "../../src/config-descriptor";
import { Store } from "../../src/utils/store";
import { useConfig } from "../../src/react";

const bannerIsActive = new Store(false);
// Exposed so the Playwright spec can drive updates from outside React, the
// same way a live `Source` (sse, file, pull) would push a new snapshot.
(globalThis as unknown as { bannerIsActive: Store<boolean> }).bannerIsActive = bannerIsActive;

function App() {
  const active = useConfig(bannerIsActive);

  return (
    <div>
      <p data-testid="banner-state">{active ? "active" : "inactive"}</p>
      <button data-testid="toggle" onClick={() => bannerIsActive.set(!bannerIsActive.get())}>
        Toggle
      </button>
    </div>
  );
}

// A source that only publishes after a short delay, so `cfg.foo` starts out
// `null` and the component below reads it — via useConfig — before
// `create()`'s returned node has resolved at all.
const delayedSource = new Source<{ foo: boolean }>({
  async start(control) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    control.set({ foo: true });
    control.close();
  },
});
const cfg = create({ foo: boolean({ required: true }) }, { sources: [delayedSource] });

function AsyncApp() {
  const foo = useConfig(cfg.foo);

  return <p data-testid="foo-state">{foo === null ? "pending" : foo ? "true" : "false"}</p>;
}

createRoot(document.getElementById("app")!).render(<App />);
createRoot(document.getElementById("async-app")!).render(<AsyncApp />);
