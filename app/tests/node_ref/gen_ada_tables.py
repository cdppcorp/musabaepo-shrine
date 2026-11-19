"""Ada(Node 내장 WHATWG URL 파서)의 IDNA · 정규화 표를 뽑아 shrine/logic/_ada_tables.py를 만듭니다.

Node 24.14는 Ada 3.4.2를 씁니다 (``node -p process.versions.ada``). 표는 Ada 소스(IDNA 17.0.0)에서 숫자만 옮깁니다.
Ada는 Apache-2.0 / MIT 이중 라이선스이고, 표 내용은 유니코드 데이터(UTS #46 · UCD)입니다.

다시 만들 때 (Node를 올려 Ada 판이 바뀌었을 때):

    curl -L -o singleheader.zip https://github.com/ada-url/ada/releases/download/v<판>/singleheader.zip
    unzip singleheader.zip ada.cpp ada.h
    uv run python tests/node_ref/gen_ada_tables.py ada.cpp shrine/logic/_ada_tables.py

시험(tests/test_logic_links.py)이 코드 포인트 전체를 Node와 맞춰 보므로, 표가 어긋나면 그 시험이 실패합니다.
"""

from __future__ import annotations

import base64
import os
import re
import sys
import zlib
from array import array

DIRECTIONS = [
    "NONE", "BN", "CS", "ES", "ON", "EN", "L", "R", "NSM", "AL", "AN", "ET", "WS",
    "RLO", "LRO", "PDF", "RLE", "RLI", "FSI", "PDI", "LRI", "B", "S", "LRE",
]  # fmt: skip


def block(src: str, decl: str) -> str:
    """``decl``(예: 'const uint32_t mappings[') 뒤 첫 '{'부터 짝이 맞는 '}'까지."""
    at = src.index(decl)
    start = src.index("{", at)
    depth = 0
    for i in range(start, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                body = src[start : i + 1]
                body = re.sub(r"//[^\n]*", "", body)
                return re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    raise ValueError(decl)


def numbers(body: str) -> list[int]:
    return [int(t, 0) for t in re.findall(r"\b(?:0[xX][0-9a-fA-F]+|\d+)\b", body)]


def rows(body: str, width: int, count: int) -> list[int]:
    """2차원 표: 안쪽 {…}마다 숫자를 읽고 C++처럼 모자란 칸은 0으로 채웁니다."""
    inner = re.findall(r"\{([^{}]*)\}", body[1:-1])
    assert len(inner) <= count, (len(inner), count)
    out: list[int] = []
    for r in inner:
        vals = numbers(r)
        assert len(vals) <= width
        out.extend(vals + [0] * (width - len(vals)))
    out.extend([0] * (width * (count - len(inner))))
    return out


def pack(values: list[int], code: str) -> str:
    a = array(code, values)
    if sys.byteorder != "little":
        a.byteswap()
    return base64.b64encode(zlib.compress(a.tobytes(), 9)).decode("ascii")


def main(src_path: str, out_path: str) -> None:
    src = open(src_path, encoding="utf-8").read()
    header = os.path.join(os.path.dirname(src_path), "ada.h")
    head = open(header, encoding="utf-8").read() if os.path.exists(header) else ""
    m = re.search(r"Ada version (\d+\.\d+\.\d+)|#define ADA_VERSION \"(\d+\.\d+\.\d+)\"", src + head)
    ver = (m.group(1) or m.group(2)) if m else "?"
    idna_ver = re.search(r"// IDNA\s+(\d+\.\d+\.\d+)", src)
    tables: dict[str, tuple[str, list[int]]] = {}
    tables["mappings"] = ("I", numbers(block(src, "const uint32_t mappings[")))
    flat = numbers(block(src, "const uint32_t table["))
    tables["table_start"] = ("I", flat[0::2])
    tables["table_desc"] = ("I", flat[1::2])
    for name, code in [
        ("decomposition_index", "B"),
        ("decomposition_block", "H"),
        ("decomposition_data", "I"),
        ("canonical_combining_class_index", "B"),
        ("canonical_combining_class_block", "B"),
        ("composition_index", "B"),
        ("composition_block", "H"),
        ("composition_data", "I"),
    ]:
        decl = re.search(r"const \w+ " + name + r"\[", src)
        assert decl, name
        body = block(src, decl.group(0))
        dims = re.search(name + r"\[(\d+)\]\[(\d+)\]", src)
        tables[name] = (code, rows(body, int(dims.group(2)), int(dims.group(1))) if dims else numbers(body))
    dirs = re.findall(r"\{(0x[0-9a-fA-F]+),\s*(0x[0-9a-fA-F]+),\s*direction::(\w+)\}", block(src, "static directions dir_table[]"))
    tables["dir_start"] = ("I", [int(a, 16) for a, _, _ in dirs])
    tables["dir_final"] = ("I", [int(b, 16) for _, b, _ in dirs])
    tables["dir_value"] = ("B", [DIRECTIONS.index(d) for _, _, d in dirs])
    for name in ["combining", "virama", "R", "L", "D"]:
        tables["join_" + name if len(name) == 1 else name] = ("I", numbers(block(src, f"constexpr static uint32_t {name}[]")))

    sizes = {
        "mappings": 5264, "table_start": 8198, "decomposition_index": 4352, "decomposition_block": 67 * 257,
        "decomposition_data": 9102, "canonical_combining_class_index": 4352, "canonical_combining_class_block": 67 * 256,
        "composition_index": 4352, "composition_block": 67 * 257, "composition_data": 1883,
    }  # fmt: skip
    for k, n in sizes.items():
        assert len(tables[k][1]) == n, (k, len(tables[k][1]), n)

    lines = [
        '"""자동 생성: tests/node_ref/gen_ada_tables.py — 손으로 고치지 마세요.',
        "",
        f"Ada {ver} (Node 24 내장 URL 파서)의 IDNA {idna_ver.group(1) if idna_ver else '?'} 매핑 표 · NFC 정규화 표 · 양방향 표 · ContextJ 표.",
        "Ada는 Apache-2.0 / MIT 이중 라이선스입니다 (https://github.com/ada-url/ada). 값은 유니코드 데이터입니다.",
        '"""',
        "",
        "import base64 as _b64",
        "import sys as _sys",
        "import zlib as _zlib",
        "from array import array as _array",
        "",
        f'ADA_VERSION = "{ver}"',
        f'IDNA_VERSION = "{idna_ver.group(1) if idna_ver else "?"}"',
        f"DIRECTIONS = {DIRECTIONS!r}",
        "",
        "",
        "def _load(code, data):",
        "    a = _array(code)",
        "    a.frombytes(_zlib.decompress(_b64.b64decode(data)))",
        '    if _sys.byteorder != "little":',
        "        a.byteswap()",
        "    return a",
        "",
        "",
    ]
    for name, (code, values) in tables.items():
        data = pack(values, code)
        chunks = [data[i : i + 100] for i in range(0, len(data), 100)]
        lines.append(f"{name} = _load(")
        lines.append(f'    "{code}",')
        lines.append("    (")
        lines.extend(f'        "{c}"' for c in chunks)
        lines.append("    ),")
        lines.append(")")
    lines.append("")
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print("wrote", out_path, {k: len(v[1]) for k, v in tables.items()})


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
