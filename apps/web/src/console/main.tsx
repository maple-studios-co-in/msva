import React from "react";
import { createRoot } from "react-dom/client";
import { Console } from "./Console";
import "../styles.css";
import "./console.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Console />
  </React.StrictMode>
);
