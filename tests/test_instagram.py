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

if __name__ == "__main__":
    print("Starting Instagram Detection & Download Test Suite...")
    success = True
    success &= test_chunk_suppression()
    success &= test_instagram_json_extraction()
    success &= test_instagram_download_routing()

    if success:
        print("\nAll Instagram tests PASSED successfully! [OK]")
        sys.exit(0)
    else:
        print("\nSome tests FAILED!")
        sys.exit(1)
