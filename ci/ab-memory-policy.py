"""Park and restore the frontend-engineering-memory block in the pilot AGENTS.md."""
import re
import sys

BLOCK = re.compile(
    r"<!-- BEGIN:frontend-engineering-memory -->.*?<!-- END:frontend-engineering-memory -->\n?",
    re.S,
)


def main() -> int:
    action, agents, parked = sys.argv[1], sys.argv[2], sys.argv[3]
    text = open(agents, encoding="utf-8").read()

    if action == "park":
        match = BLOCK.search(text)
        if not match:
            print("memory block not found in AGENTS.md", file=sys.stderr)
            return 1
        open(parked, "w", encoding="utf-8").write(match.group(0))
        open(agents, "w", encoding="utf-8").write(text[: match.start()] + text[match.end() :])
        return 0

    block = open(parked, encoding="utf-8").read()
    if text and not text.endswith("\n"):
        text += "\n"
    open(agents, "w", encoding="utf-8").write(text + block)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
