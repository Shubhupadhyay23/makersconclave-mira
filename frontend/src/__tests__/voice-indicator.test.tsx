import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import VoiceIndicator from "@/components/mirror/VoiceIndicator";

describe("VoiceIndicator", () => {
  it("renders nothing when not listening", () => {
    const { container } = render(
      <VoiceIndicator isListening={false} interimTranscript="" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows indicator when listening", () => {
    render(<VoiceIndicator isListening={true} interimTranscript="" />);
    expect(
      document.querySelector("[data-testid='voice-indicator']"),
    ).not.toBeNull();
  });

  it("displays interim transcript text", () => {
    render(
      <VoiceIndicator
        isListening={true}
        interimTranscript="I want something"
      />,
    );
    expect(screen.getByText("I want something")).toBeDefined();
  });

  it("updates transcript when prop changes", () => {
    const { rerender } = render(
      <VoiceIndicator isListening={true} interimTranscript="Hello" />,
    );
    expect(screen.getByText("Hello")).toBeDefined();

    rerender(
      <VoiceIndicator isListening={true} interimTranscript="Hello world" />,
    );
    expect(screen.getByText("Hello world")).toBeDefined();
  });
});
