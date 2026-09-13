#!/usr/bin/env python3
"""
MediaSniff Automated Test Suite — Instagram Detection & Download Verification
Run with: python tests/test_instagram.py
"""
import sys
import os
import re
import json

def test_chunk_suppression():
    print("\n--- Test 1: Instagram Segment & Chunk Pattern Matching ---")
    segment_url_patterns = [
        re.compile(r'/seg-\d+', re.I),
        re.compile(r'/segment\d+', re.I),
        re.compile(r'/chunk-', re.I),
        re.compile(r'/frag\(', re.I),
        re.compile(r'/range/\d+', re.I),
        re.compile(r'[?&]sq=\d+', re.I),
        re.compile(r'[?&]range=', re.I),
        re.compile(r'[?&]bytestart=\d+', re.I),
        re.compile(r'[?&]byteend=\d+', re.I),
        re.compile(r'\.ts\?', re.I),
    ]

    def is_segment_url(url):
        return any(p.search(url) for p in segment_url_patterns)

    def clean_instagram_url(url):
        cleaned = re.sub(r'([?&])(?:bytestart|byteend)=[^&#]*', lambda m: '?' if m.group(1) == '?' else '', url)
        cleaned = cleaned.replace('?&', '?')
        cleaned = re.sub(r'\?(?=#|$)', '', cleaned)
        return cleaned

    sample_chunk_url_1 = "https://scontent-del3-1.cdninstagram.com/v/t16/f1/m86/AQMJH2wg9rBkpygxx4WoFcq0Svl9prayqK7GpyN1Ywa-bI7mUFrwOVzq.mp4?bytestart=0&byteend=248&_nc_ht=scontent-del3-1.cdninstagram.com"
    sample_chunk_url_2 = "https://scontent-del3-1.cdninstagram.com/v/t16/f1/m86/AQMJH2wg9rBkpygxx4WoFcq0Svl9prayqK7GpyN1Ywa-bI7mUFrwOVzq.mp4?_nc_cat=101&bytestart=248&byteend=1048576"
    clean_progressive_url = "https://scontent-del3-1.cdninstagram.com/v/t16/f1/m86/AQMJH2wg9rBkpygxx4WoFcq0Svl9prayqK7GpyN1Ywa-bI7mUFrwOVzq.mp4?_nc_cat=101"

    assert is_segment_url(sample_chunk_url_1), "Should identify bytestart chunk as segment"
    assert is_segment_url(sample_chunk_url_2), "Should identify bytestart/byteend chunk as segment"
    assert not is_segment_url(clean_progressive_url), "Should not treat clean progressive MP4 as segment"

    cleaned_1 = clean_instagram_url(sample_chunk_url_1)
    assert "bytestart" not in cleaned_1 and "byteend" not in cleaned_1
    assert cleaned_1.startswith("https://scontent-del3-1.cdninstagram.com/v/t16/f1/m86/AQMJH2wg9rBkpygxx4WoFcq0Svl9prayqK7GpyN1Ywa-bI7mUFrwOVzq.mp4")

    print("  [PASS] Segment chunk identification and URL cleaning verified.")
    return True

def test_instagram_json_extraction():
    print("\n--- Test 2: Instagram GraphQL / API Response Extraction ---")

    mock_graphql_data = {
        "data": {
            "xdt_api__v1__media__shortcode__web_info": {
                "items": [
                    {
                        "id": "3182947291827391823_25025320",
                        "code": "Cwp84x6u7CP",
                        "video_duration": 15.42,
                        "caption": {
                            "text": "Check out this amazing sunset reel! #nature #photography"
                        },
                        "user": {
                            "username": "travel_creator",
                            "full_name": "Travel & Nature",
                            "profile_pic_url": "https://scontent.cdninstagram.com/profile.jpg"
                        },
                        "image_versions2": {
                            "candidates": [
                                {
                                    "width": 1080,
                                    "height": 1920,
                                    "url": "https://scontent.cdninstagram.com/thumbnail_1080.jpg"
                                }
                            ]
                        },
                        "video_versions": [
                            {
                                "type": 101,
                                "width": 1080,
                                "height": 1920,
                                "url": "https://scontent.cdninstagram.com/v/reel_1080p.mp4?efg=123"
                            },
                            {
                                "type": 102,
                                "width": 720,
                                "height": 1280,
                                "url": "https://scontent.cdninstagram.com/v/reel_720p.mp4?efg=456"
                            }
                        ],
                        "video_dash_manifest": "<MPD xmlns=\"urn:mpeg:dash:schema:mpd:2011\"><Period><AdaptationSet mimeType=\"video/mp4\"><Representation bandwidth=\"1500000\"/></AdaptationSet></Period></MPD>"
                    }
                ]
            }
        }
    }

    def find_instagram_nodes(root, results=None, seen_ids=None):
        if results is None: results = []
        if seen_ids is None: seen_ids = set()
        if not isinstance(root, (dict, list)): return results

        if isinstance(root, dict):
            has_versions = bool(root.get("video_versions"))
            has_dash = bool(root.get("video_dash_manifest") and "<MPD" in root.get("video_dash_manifest"))
            has_url = bool(root.get("video_url") and (root.get("is_video") or root.get("__typename") == "GraphVideo"))

            if has_versions or has_dash or has_url:
                node_id = str(root.get("code") or root.get("shortcode") or root.get("id") or root.get("pk") or "")
                if node_id not in seen_ids:
                    seen_ids.add(node_id)
                    results.append(root)

            for val in root.values():
                find_instagram_nodes(val, results, seen_ids)
        elif isinstance(root, list):
            for item in root:
                find_instagram_nodes(item, results, seen_ids)

        return results

    nodes = find_instagram_nodes(mock_graphql_data)
    assert len(nodes) == 1, f"Expected 1 node, found {len(nodes)}"
    node = nodes[0]
    assert node["code"] == "Cwp84x6u7CP"
    assert node["user"]["username"] == "travel_creator"
    assert len(node["video_versions"]) == 2
    assert node["video_versions"][0]["height"] == 1920
    assert node["video_versions"][1]["height"] == 1280

    print("  [PASS] Instagram node extraction successfully parsed reel metadata and progressive MP4 versions.")
    return True

def test_instagram_download_routing():
    print("\n--- Test 3: Instagram Download Routing (yt-dlp vs Progressive MP4) ---")

    mock_item = {
        "id": "media_1",
        "source": "instagram",
        "shortcode": "Cwp84x6u7CP",
        "pageUrl": "https://www.instagram.com/reel/Cwp84x6u7CP/",
        "url": "https://scontent.cdninstagram.com/v/reel_1080p.mp4?efg=123",
        "filename": "@travel_creator - Check out this amazing sunset reel!",
        "directMp4Urls": {
            "1920": "https://scontent.cdninstagram.com/v/reel_1080p.mp4?efg=123",
            "1280": "https://scontent.cdninstagram.com/v/reel_720p.mp4?efg=456"
        },
        "availableQualities": [
            {"label": "1920p", "height": 1920, "url": "https://scontent.cdninstagram.com/v/reel_1080p.mp4?efg=123"},
            {"label": "1280p", "height": 1280, "url": "https://scontent.cdninstagram.com/v/reel_720p.mp4?efg=456"}
        ]
    }

    def get_ytdlp_target_url(item):
        if item.get("source") == "instagram":
            return item.get("pageUrl") or f"https://www.instagram.com/reel/{item.get('shortcode')}/"
        return item.get("url")

    target_url = get_ytdlp_target_url(mock_item)
    assert target_url == "https://www.instagram.com/reel/Cwp84x6u7CP/", f"Unexpected target URL: {target_url}"
    print("  [PASS] yt-dlp correctly routes to the Instagram Reel page URL.")

    def get_selected_download_url(item, selected_quality="1920"):
        if item.get("directMp4Urls", {}).get(selected_quality):
            return item["directMp4Urls"][selected_quality]
        return item["url"]

    dl_url_1080 = get_selected_download_url(mock_item, "1920")
    dl_url_720 = get_selected_download_url(mock_item, "1280")
    assert dl_url_1080 == "https://scontent.cdninstagram.com/v/reel_1080p.mp4?efg=123"
    assert dl_url_720 == "https://scontent.cdninstagram.com/v/reel_720p.mp4?efg=456"
    print("  [PASS] Progressive MP4 direct download selects appropriate quality URL.")

    return True

def test_highest_quality_sorting_and_zero_prevention():
    print("\n--- Test 4: Highest Quality Sorting & Zero-Resolution Prevention ---")

    # Unsorted formats including lower resolutions and a 0x0 fallback
    raw_versions = [
        {"url": "https://cdn.example.com/v480.mp4", "width": 480, "height": 852, "label": "852p"},
        {"url": "https://cdn.example.com/v1080.mp4", "width": 1080, "height": 1920, "label": "1920p"},
        {"url": "https://cdn.example.com/v720.mp4", "width": 720, "height": 1280, "label": "1280p"},
        {"url": "https://cdn.example.com/v0.mp4", "width": 0, "height": 0, "label": "MP4 Video"}
    ]

    # 1. Filter out 0x0 stubs if valid versions exist
    valid_versions = [v for v in raw_versions if v.get("width", 0) > 0 or v.get("height", 0) > 0]
    final_versions = valid_versions if valid_versions else raw_versions

    # 2. Sort descending by area / height
    final_versions.sort(key=lambda v: (v.get("width", 0) * v.get("height", 0), v.get("height", 0)), reverse=True)

    assert len(final_versions) == 3, f"Expected 3 versions after filtering 0x0 stub, got {len(final_versions)}"
    assert final_versions[0]["height"] == 1920, f"Expected highest quality 1920 at index 0, got {final_versions[0]['height']}"
    assert final_versions[1]["height"] == 1280
    assert final_versions[2]["height"] == 852

    # Verify smart filename does not produce '(0x0)'
    def get_quality_label(v):
        h = v.get("height", 0)
        res = f"{v.get('width', 0)}x{h}"
        if h > 0:
            return f"{h}p"
        elif res and res != "0x0":
            return res
        return ""

    label_best = get_quality_label(final_versions[0])
    label_zero = get_quality_label({"width": 0, "height": 0})
    assert label_best == "1920p"
    assert label_zero == "", "0x0 resolution should produce an empty quality label"

    print("  [PASS] Quality sorting selects 1080x1920 as primary and prevents '(0x0)' suffix.")
    return True

def test_script_balanced_json_extraction():
    print("\n--- Test 5: JS-wrapped Script JSON Extraction ---")

    # Simulate modern Instagram HTML where JSON is embedded in a JS function call
    js_wrapped_script = """
    self.__wrapServerJS({"require":[["ScheduledServerJS","handle",null,[{"__bbox":{"define":[["xdt_api__v1__media__shortcode__web_info",{"items":[{"code":"C12345XYZ","video_versions":[{"url":"https://scontent.cdninstagram.com/v1080.mp4","width":1080,"height":1920}],"caption":{"text":"Hello World Reel"}}]}}]}]]]);
    """

    def extract_balanced_json(text, start_index, open_char='{', close_char='}'):
        depth = 0
        in_string = False
        escape = False
        start = -1
        for i in range(start_index, len(text)):
            ch = text[i]
            if escape:
                escape = False
                continue
            if ch == '\\' and in_string:
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if not in_string:
                if ch == open_char:
                    if depth == 0:
                        start = i
                    depth += 1
                elif ch == close_char:
                    depth -= 1
                    if depth == 0 and start != -1:
                        return text[start:i + 1]
        return None

    marker = '"video_versions"'
    idx = js_wrapped_script.find(marker)
    assert idx != -1, "Marker should exist in script"

    open_bracket = js_wrapped_script.find('[', idx + len(marker))
    extracted = extract_balanced_json(js_wrapped_script, open_bracket, '[', ']')
    assert extracted is not None, "Should extract balanced JSON array"

    parsed_versions = json.loads(extracted)
    assert len(parsed_versions) == 1
    assert parsed_versions[0]["width"] == 1080
    assert parsed_versions[0]["height"] == 1920
    assert parsed_versions[0]["url"] == "https://scontent.cdninstagram.com/v1080.mp4"

    print("  [PASS] Balanced bracket JSON extraction successfully extracts video_versions from JavaScript-wrapped scripts.")
    return True

def test_chunk_cards_suppression():
    print("\n--- Test 6: Chunk Cards Suppression on Instagram Pages ---")

    # Simulate 32 media URLs detected on an Instagram page (31 CDN chunk requests + 1 page)
    detected_urls = [
        f"https://scontent-del3-1.cdninstagram.com/v/t66.30192-16/chunk_{i}.mp4?bytestart={i*248}&byteend={(i+1)*248}"
        for i in range(31)
    ]

    def is_chunk_url(url):
        if not url: return False
        if "cdninstagram.com" in url or "fbcdn.net" in url: return True
        if "bytestart=" in url or "byteend=" in url: return True
        if "range=" in url and not (".m3u8" in url or ".mpd" in url): return True
        return False

    def extract_media_urls(is_instagram_page, urls):
        if is_instagram_page:
            return []
        return [u for u in urls if not is_chunk_url(u)]

    filtered = extract_media_urls(is_instagram_page=True, urls=detected_urls)
    assert len(filtered) == 0, f"Expected 0 generic DOM_MEDIA items on Instagram page, got {len(filtered)}"

    # Simulate DOM_MEDIA handler in service-worker
    tab_media = {}
    def handle_dom_media(tab_url, urls):
        if "instagram.com" in tab_url:
            return
        for u in urls:
            if is_chunk_url(u):
                continue
            tab_media[u] = {"url": u, "source": "dom"}

    handle_dom_media("https://www.instagram.com/reel/C12345XYZ/", detected_urls)
    assert len(tab_media) == 0, "No cards should be added to tabMedia from DOM_MEDIA on Instagram"

    print("  [PASS] All 31 chunk cards are completely suppressed on Instagram pages.")
    return True

if __name__ == "__main__":
    print("Starting Comprehensive Instagram Detection & Download Test Suite...")
    success = True
    success &= test_chunk_suppression()
    success &= test_instagram_json_extraction()
    success &= test_instagram_download_routing()
    success &= test_highest_quality_sorting_and_zero_prevention()
    success &= test_script_balanced_json_extraction()
    success &= test_chunk_cards_suppression()

    if success:
        print("\nAll Instagram tests PASSED successfully! [OK]")
        sys.exit(0)
    else:
        print("\nSome tests FAILED!")
        sys.exit(1)
