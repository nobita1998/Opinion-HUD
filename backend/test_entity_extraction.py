#!/usr/bin/env python3
"""Test entity extraction logic"""
import json


def _extract_keywords_and_entities(text):
    """Extract both keywords and entities from AI response.

    Expected format:
    {
      "keywords": ["keyword1", "keyword2", ...],
      "entities": ["Entity1", "Entity2"]
    }

    Fallback to legacy array format if object not found.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return {"keywords": [], "entities": []}

    # Try to extract JSON from markdown code blocks
    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            candidate = part.strip()
            # Try object format first
            if candidate.startswith("{") and candidate.endswith("}"):
                cleaned = candidate
                break
            # Try array format (legacy)
            if candidate.startswith("[") and candidate.endswith("]"):
                cleaned = candidate
                break
            # Handle json-prefixed code blocks
            if candidate.startswith("json"):
                if "{" in candidate and "}" in candidate:
                    cleaned = candidate[candidate.find("{") : candidate.rfind("}") + 1].strip()
                    break
                elif "[" in candidate and "]" in candidate:
                    cleaned = candidate[candidate.find("[") : candidate.rfind("]") + 1].strip()
                    break

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        print(f"[warn] LLM output was not valid JSON; preview={cleaned[:100]}")
        return {"keywords": [], "entities": []}

    # Handle new object format
    if isinstance(data, dict):
        keywords_raw = data.get("keywords", [])
        entities_raw = data.get("entities", [])

        keywords = []
        if isinstance(keywords_raw, list):
            for item in keywords_raw:
                if isinstance(item, str):
                    kw = item.strip()
                    if kw:
                        keywords.append(kw)

        entities = []
        if isinstance(entities_raw, list):
            for item in entities_raw:
                if isinstance(item, str):
                    ent = item.strip()
                    if ent:
                        entities.append(ent)

        return {"keywords": keywords, "entities": entities}

    # Handle legacy array format (backwards compatibility)
    if isinstance(data, list):
        keywords = []
        for item in data:
            if isinstance(item, str):
                kw = item.strip()
                if kw:
                    keywords.append(kw)
        return {"keywords": keywords, "entities": []}

    return {"keywords": [], "entities": []}


if __name__ == "__main__":
    # Test 1: New format with entities
    test1 = '''
{
  "keywords": ["lighter", "fdv", "market cap", "launch", "tge"],
  "entities": ["Lighter"]
}
'''
    result1 = _extract_keywords_and_entities(test1)
    print("Test 1 - New format with entities:")
    print(json.dumps(result1, indent=2))
    assert result1["keywords"] == ["lighter", "fdv", "market cap", "launch", "tge"]
    assert result1["entities"] == ["Lighter"]
    print("✓ PASS\n")

    # Test 2: Legacy array format
    test2 = '''
["kraken", "ipo", "exchange", "listing"]
'''
    result2 = _extract_keywords_and_entities(test2)
    print("Test 2 - Legacy array format:")
    print(json.dumps(result2, indent=2))
    assert result2["keywords"] == ["kraken", "ipo", "exchange", "listing"]
    assert result2["entities"] == []
    print("✓ PASS\n")

    # Test 3: Markdown code block
    test3 = '''
```json
{
  "keywords": ["blackpink", "2ne1", "comeback", "reunion"],
  "entities": ["Blackpink", "2NE1"]
}
```
'''
    result3 = _extract_keywords_and_entities(test3)
    print("Test 3 - Markdown code block:")
    print(json.dumps(result3, indent=2))
    assert result3["keywords"] == ["blackpink", "2ne1", "comeback", "reunion"]
    assert result3["entities"] == ["Blackpink", "2NE1"]
    print("✓ PASS\n")

    # Test 4: Multiple entities
    test4 = '''
{
  "keywords": ["standx", "stx", "protocol", "defi", "staking"],
  "entities": ["StandX"]
}
'''
    result4 = _extract_keywords_and_entities(test4)
    print("Test 4 - StandX market:")
    print(json.dumps(result4, indent=2))
    assert result4["entities"] == ["StandX"]
    print("✓ PASS\n")

    print("All tests passed! ✓")
