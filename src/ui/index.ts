import { definePluginApp, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { createElement } from "react";
import { FactoryView } from "./FactoryView.js";

function FactoryPanel({ subPath }: PluginNavPanelProps) {
  return createElement(FactoryView, { subPath, panelPath: "factory" });
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "factory",
    title: "Factory",
    icon: "Factory",
    path: "factory",
    component: FactoryPanel,
  });
});
