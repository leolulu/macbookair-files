"""SRT Subtitle Translator - MVP

Translates SRT subtitle files to Chinese using LLM batch translation.
Key feature: translates ALL subtitle lines at once for better context awareness,
with strict line-count validation to ensure 1:1 correspondence.

Usage:
    uv run main.py input.srt
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

# ---------------------------------------------------------------------------
# 1. SRT Parser
# ---------------------------------------------------------------------------


@dataclass
class SubtitleBlock:
    """Represents a single subtitle block in SRT format."""

    index: int
    start_time: str
    end_time: str
    text: str  # may contain internal newlines


def parse_srt(content: str) -> list[SubtitleBlock]:
    """Parse SRT content into a list of SubtitleBlock objects.

    SRT format:
        1
        00:00:01,000 --> 00:00:04,000
        Hello world

        2
        00:00:05,000 --> 00:00:08,000
        How are you?
    """
    # Normalize line endings
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    # Split on blank lines (one or more consecutive newlines)
    blocks = re.split(r"\n\n+", content.strip())

    result = []
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            continue  # Skip malformed blocks

        # Parse index (first line)
        try:
            index = int(lines[0].strip())
        except ValueError:
            continue  # Skip if index is not a number

        # Parse timecode (second line)
        timecode_match = re.match(
            r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})",
            lines[1].strip(),
        )
        if not timecode_match:
            continue  # Skip if timecode is invalid

        start_time = timecode_match.group(1).replace(",", ",")
        end_time = timecode_match.group(2).replace(",", ",")

        # Text is everything after the timecode
        text = "\n".join(lines[2:]).strip()
        if not text:
            continue

        result.append(
            SubtitleBlock(
                index=index,
                start_time=start_time,
                end_time=end_time,
                text=text,
            )
        )

    return result


def format_srt(blocks: list[SubtitleBlock]) -> str:
    """Format SubtitleBlock objects back into SRT string."""
    parts = []
    for block in blocks:
        # Normalize timecode: ensure comma separator (SRT standard uses comma)
        start = block.start_time.replace(".", ",")
        end = block.end_time.replace(".", ",")
        parts.append(
            f"{block.index}\n"
            f"{start} --> {end}\n"
            f"{block.text}\n"
        )
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# 2. LLM Translator
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a professional subtitle translator. You translate subtitle text accurately and naturally, preserving the tone and style appropriate for the context."""

MAX_RETRIES = 3


def build_user_prompt(texts: list[str]) -> str:
    """Build the prompt that sends all subtitle texts at once.

    Format:
        Translate the following subtitle texts to Chinese.
        Return ONLY the translated text for each entry, one entry per line.
        Do NOT include numbers, do NOT include any extra text.

        Input:
        1. Hello world
        2. How are you?
        3. I'm fine, thank you.
    """
    numbered_texts = "\n".join(f"{i+1}. {text.replace(chr(10), ' ')}" for i, text in enumerate(texts))
    return (
        f"Translate the following {len(texts)} subtitle texts to Simplified Chinese (zh-CN).\n"
        "Rules:\n"
        f"1. You MUST return EXACTLY {len(texts)} lines of translated text.\n"
        "2. Each line corresponds to the numbered input.\n"
        "3. Do NOT include numbers or any prefix in your output.\n"
        "4. Do NOT include any explanations or extra text.\n"
        "5. If a line is empty, return an empty line.\n"
        "6. Keep the order exactly the same as the input.\n"
        "\n"
        f"Input ({len(texts)} lines):\n"
        f"{numbered_texts}\n"
        "\n"
        f"Output (exactly {len(texts)} lines, translated to Simplified Chinese):"
    )


def translate_batch(
    client: OpenAI,
    model: str,
    texts: list[str],
    retry: int = 0,
) -> list[str]:
    """Translate a batch of texts using LLM.

    Returns list of translated strings, one per input text.
    Retries up to MAX_RETRIES times if line count doesn't match.
    """
    prompt = build_user_prompt(texts)

    # Add retry-specific instruction
    if retry > 0:
        prompt += (
            f"\n\nWARNING: Your previous attempt returned the wrong number of lines. "
            f"You returned some number of lines, but I need EXACTLY {len(texts)} lines. "
            f"Each of the {len(texts)} input entries must have exactly one corresponding translated line. "
            f"Please try again and ensure you return exactly {len(texts)} lines."
        )

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,  # Low temperature for consistency
    )

    content = response.choices[0].message.content
    if content is None:
        raise ValueError("LLM returned empty response")

    # Parse response: split by newlines, strip empty lines at start/end
    lines = content.strip().split("\n")

    # Clean up: remove numbering prefix if model added any (e.g., "1. 你好")
    cleaned_lines = []
    for line in lines:
        # Remove patterns like "1. ", "1、", "1) ", etc.
        cleaned = re.sub(r"^\d+[\.\、\)\s]*", "", line).strip()
        cleaned_lines.append(cleaned)

    # Validate line count
    if len(cleaned_lines) != len(texts):
        if retry < MAX_RETRIES:
            print(
                f"  Line count mismatch: expected {len(texts)}, got {len(cleaned_lines)}. "
                f"Retrying ({retry + 1}/{MAX_RETRIES})..."
            )
            return translate_batch(client, model, texts, retry + 1)
        else:
            raise ValueError(
                f"Line count mismatch after {MAX_RETRIES} retries: "
                f"expected {len(texts)}, got {len(cleaned_lines)}"
            )

    return cleaned_lines


# ---------------------------------------------------------------------------
# 3. Main orchestration
# ---------------------------------------------------------------------------


def translate_srt(
    input_path: Path,
    client: OpenAI,
    model: str,
) -> None:
    """Translate an entire SRT file in one batch call.

    Generates TWO output files next to the input:
    1. {stem}_zh.srt — pure Chinese only
    2. {stem}_bilingual.srt — original<br>Chinese
    """
    print(f"Reading: {input_path}")
    content = input_path.read_text(encoding="utf-8")

    blocks = parse_srt(content)
    if not blocks:
        print("Error: No valid subtitle blocks found in the input file.")
        sys.exit(1)

    print(f"Found {len(blocks)} subtitle blocks.")

    # Extract all texts for batch translation
    texts = [block.text.replace("\n", " ") for block in blocks]

    print(f"Sending {len(texts)} lines to LLM for batch translation...")
    translated_texts = translate_batch(client, model, texts)

    # Build pure Chinese blocks
    zh_blocks = []
    bilingual_blocks = []
    for block, translated_text in zip(blocks, translated_texts):
        original_text = block.text.replace("\n", " ")
        # Pure Chinese
        zh_blocks.append(
            SubtitleBlock(
                index=block.index,
                start_time=block.start_time,
                end_time=block.end_time,
                text=translated_text,
            )
        )
        # Bilingual: original<br>Chinese
        bilingual_blocks.append(
            SubtitleBlock(
                index=block.index,
                start_time=block.start_time,
                end_time=block.end_time,
                text=f"{original_text}<br>{translated_text}",
            )
        )

    # Derive output paths next to input file
    zh_path = input_path.with_stem(f"{input_path.stem}_zh").with_suffix(".srt")
    bilingual_path = input_path.with_stem(f"{input_path.stem}_bilingual").with_suffix(".srt")

    zh_path.write_text(format_srt(zh_blocks), encoding="utf-8")
    print(f"Pure Chinese saved to: {zh_path}")

    bilingual_path.write_text(format_srt(bilingual_blocks), encoding="utf-8")
    print(f"Bilingual saved to: {bilingual_path}")


def main():
    parser = argparse.ArgumentParser(description="SRT Subtitle Translator (LLM-powered)")
    parser.add_argument("input", type=Path, help="Input SRT file path")
    args = parser.parse_args()

    # Load .env
    load_dotenv()

    base_url = os.getenv("OPENAI_BASE_URL")
    api_key = os.getenv("OPENAI_API_KEY")
    model_name = os.getenv("OPENAI_MODEL_NAME")

    if not base_url or not api_key or not model_name:
        print("Error: Missing required environment variables.")
        print("Please set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL_NAME in your .env file.")
        sys.exit(1)

    client = OpenAI(base_url=base_url, api_key=api_key)

    translate_srt(args.input, client, model_name)


if __name__ == "__main__":
    main()
