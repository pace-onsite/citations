import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { currentPage } from "./components/PageNav";
import { EvalPage } from "./pages/EvalPage";
import "./styles.css";

const page = currentPage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{page === "eval" ? <EvalPage /> : <App />}</React.StrictMode>,
);
