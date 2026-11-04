import React from "react";
import { render, screen } from "@testing-library/react";
import { Welcome } from "./welcome";
test("renders a Gatsby link with a supplied name", () => { render(<Welcome name="reader" />); expect(screen.getByRole("link", { name: "Hello reader" })).toHaveAttribute("href", "/"); });
test("renders the visitor fallback", () => { render(<Welcome />); expect(screen.getByRole("heading")).toHaveTextContent("Hello visitor"); });
