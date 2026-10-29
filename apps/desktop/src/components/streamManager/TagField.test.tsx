import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import TagField from "./TagField";

function setup(initial: string[]) {
  const [tags, setTags] = createSignal(initial);
  const onChange = vi.fn(setTags);
  render(() => <TagField tags={tags()} onChange={onChange} />);
  return {
    tags,
    input: screen.getByLabelText("Add a tag") as HTMLInputElement,
  };
}

const type = (input: HTMLInputElement, value: string, key = "Enter") => {
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key });
};

describe("TagField", () => {
  afterEach(cleanup);

  it("adds on Enter or a comma and removes with Backspace", () => {
    const { tags, input } = setup([]);
    type(input, "Chill");
    type(input, "Größe", ",");
    type(input, "日本語");
    expect(tags()).toEqual(["Chill", "Größe", "日本語"]);
    expect(input.value).toBe("");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(tags()).toEqual(["Chill", "Größe"]);
    fireEvent.input(input, { target: { value: "ADC" } });
    fireEvent.blur(input);
    expect(tags()).toEqual(["Chill", "Größe", "ADC"]);
  });

  it("says why a tag was refused", () => {
    const { tags, input } = setup(["Chill"]);
    type(input, "two words");
    expect(screen.getByRole("alert").textContent).toContain(
      "letters and numbers only",
    );
    type(input, "a".repeat(26));
    expect(screen.getByRole("alert").textContent).toContain("up to 25");
    type(input, "chill");
    expect(screen.getByRole("alert").textContent).toContain("already a tag");
    fireEvent.input(input, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(tags()).toEqual(["Chill"]);
  });

  it("stops at ten", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `tag${i}`);
    const { input } = setup(ten);
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("All 10 used");
    expect(screen.getByText("10 of 10")).toBeTruthy();
  });
});
