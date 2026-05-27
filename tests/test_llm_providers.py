"""Tests for LLM provider factory, prompt building, response parsing, and preset metrics."""

import json
import time
from unittest.mock import patch, MagicMock

import pytest
from backend.llm_providers import (
    get_provider,
    OpenAIProvider,
    AnthropicProvider,
    GoogleProvider,
    OpenRouterProvider,
    LLMProvider,
    PRESET_METRICS,
)


class TestGetProvider:
    """Tests for the get_provider() factory function."""

    def test_openai_returns_correct_class(self):
        provider = get_provider("openai", "test-key", "gpt-4o")
        assert isinstance(provider, OpenAIProvider)

    def test_anthropic_returns_correct_class(self):
        provider = get_provider("anthropic", "test-key", "claude-3-opus")
        assert isinstance(provider, AnthropicProvider)

    def test_google_returns_correct_class(self):
        provider = get_provider("google", "test-key", "gemini-2.5-pro")
        assert isinstance(provider, GoogleProvider)

    def test_openrouter_returns_correct_class(self):
        provider = get_provider("openrouter", "test-key", "meta-llama/llama-3")
        assert isinstance(provider, OpenRouterProvider)

    def test_unknown_provider_raises(self):
        with pytest.raises(ValueError, match="Unknown provider"):
            get_provider("unknown", "test-key", "model")

    def test_case_insensitive(self):
        provider = get_provider("OpenAI", "test-key", "gpt-4o")
        assert isinstance(provider, OpenAIProvider)

    def test_advanced_settings_passed(self):
        provider = get_provider(
            "openai", "test-key", "gpt-4o",
            temperature=0.5, max_tokens=1000, top_p=0.9
        )
        assert provider.temperature == 0.5
        assert provider.max_tokens == 1000
        assert provider.top_p == 0.9


class TestReasoningModels:
    """Tests for OpenAI reasoning model detection."""

    def test_o1_detected(self):
        provider = OpenAIProvider(api_key="k", model="o1-preview")
        assert provider._is_reasoning_model() is True

    def test_o3_detected(self):
        provider = OpenAIProvider(api_key="k", model="o3-mini")
        assert provider._is_reasoning_model() is True

    def test_o4_mini_detected(self):
        provider = OpenAIProvider(api_key="k", model="o4-mini")
        assert provider._is_reasoning_model() is True

    def test_gpt4o_not_detected(self):
        provider = OpenAIProvider(api_key="k", model="gpt-4o")
        assert provider._is_reasoning_model() is False

    def test_gpt5_not_detected(self):
        provider = OpenAIProvider(api_key="k", model="gpt-5")
        assert provider._is_reasoning_model() is False


class TestBuildGradingPrompt:
    """Tests for _build_grading_prompt()."""

    def _get_provider(self):
        return OpenAIProvider(api_key="k", model="gpt-4o")

    def test_message_formatting(self):
        provider = self._get_provider()
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        prompt = provider._build_grading_prompt(messages, "Is this helpful?", "bool")
        assert "[Message 0] (user):" in prompt
        assert "Hello" in prompt
        assert "[Message 1] (assistant):" in prompt
        assert "Hi there" in prompt

    def test_bool_grade_instruction(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "bool"
        )
        assert "boolean grade" in prompt.lower() or "true or false" in prompt.lower()

    def test_int_grade_instruction(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "int"
        )
        assert "integer grade" in prompt.lower()

    def test_float_grade_instruction(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "float"
        )
        assert "float grade" in prompt.lower() or "0.0 and 1.0" in prompt

    def test_freeform_grade_instruction(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "freeform"
        )
        # Must explicitly tell the model to produce prose in `grade` and NOT a number/bool.
        assert "free-form" in prompt.lower() or "free form" in prompt.lower()
        assert "string" in prompt.lower()
        # Quote instructions still apply unchanged — freeform is orthogonal to quoting.
        assert "message_index" in prompt

    def test_required_quotes_section(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "bool",
            require_quotes=True, is_quote_retry=False,
        )
        assert "REQUIRED" in prompt
        assert "MUST" in prompt

    def test_retry_stronger_language(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "bool",
            require_quotes=True, is_quote_retry=True,
        )
        assert "RETRY" in prompt
        assert "REJECTED" in prompt

    def test_optional_quotes(self):
        provider = self._get_provider()
        prompt = provider._build_grading_prompt(
            [{"role": "user", "content": "x"}], "metric", "bool",
            require_quotes=False,
        )
        assert "Optional" in prompt


class TestParseGradeResponse:
    """Tests for _parse_grade_response()."""

    def _get_provider(self):
        return OpenAIProvider(api_key="k", model="gpt-4o")

    def test_plain_json(self):
        provider = self._get_provider()
        response = json.dumps({
            "grade": True,
            "quotes": [{"message_index": 0, "start": 0, "end": 5, "text": "Hello"}],
            "explanation": "Good response",
        })
        result = provider._parse_grade_response(response, "bool")
        assert result["grade"] is True
        assert len(result["quotes"]) == 1
        assert result["explanation"] == "Good response"

    def test_markdown_code_block(self):
        provider = self._get_provider()
        response = '```json\n{"grade": 0.8, "quotes": [], "explanation": "test"}\n```'
        result = provider._parse_grade_response(response, "float")
        assert result["grade"] == 0.8

    def test_embedded_json(self):
        provider = self._get_provider()
        response = 'Here is my evaluation:\n{"grade": true, "quotes": [], "explanation": "ok"}\nEnd.'
        result = provider._parse_grade_response(response, "bool")
        assert result["grade"] is True

    def test_bool_coercion_true(self):
        provider = self._get_provider()
        for val in [True, "true", "yes", "1"]:
            response = json.dumps({"grade": val, "quotes": [], "explanation": ""})
            result = provider._parse_grade_response(response, "bool")
            assert result["grade"] is True, f"Failed for {val}"

    def test_bool_coercion_false(self):
        provider = self._get_provider()
        for val in [False, "false", "no", "0"]:
            response = json.dumps({"grade": val, "quotes": [], "explanation": ""})
            result = provider._parse_grade_response(response, "bool")
            assert result["grade"] is False, f"Failed for {val}"

    def test_int_parsing(self):
        provider = self._get_provider()
        response = json.dumps({"grade": 7, "quotes": [], "explanation": ""})
        result = provider._parse_grade_response(response, "int")
        assert result["grade"] == 7

    def test_freeform_string_passthrough(self):
        provider = self._get_provider()
        answer = "The model shows signs of reward hacking by checking file existence."
        response = json.dumps({"grade": answer, "quotes": [], "explanation": ""})
        result = provider._parse_grade_response(response, "freeform")
        assert result["grade"] == answer
        assert isinstance(result["grade"], str)

    def test_freeform_none_becomes_empty_string(self):
        provider = self._get_provider()
        response = json.dumps({"grade": None, "quotes": [], "explanation": ""})
        result = provider._parse_grade_response(response, "freeform")
        assert result["grade"] == ""
        assert isinstance(result["grade"], str)

    def test_freeform_coerces_non_string_to_string(self):
        # Some models return a dict/list under `grade` even when asked for prose.
        # We JSON-stringify rather than crash so downstream code gets a string.
        provider = self._get_provider()
        response = json.dumps({"grade": {"summary": "ok"}, "quotes": [], "explanation": ""})
        result = provider._parse_grade_response(response, "freeform")
        assert isinstance(result["grade"], str)
        assert "summary" in result["grade"]

    def test_float_parsing(self):
        provider = self._get_provider()
        response = json.dumps({"grade": 0.85, "quotes": [], "explanation": ""})
        result = provider._parse_grade_response(response, "float")
        assert result["grade"] == 0.85
        assert isinstance(result["grade"], float)

    def test_quote_structure_validated(self):
        provider = self._get_provider()
        response = json.dumps({
            "grade": True,
            "quotes": [{"message_index": 2, "start": 10, "end": 20, "text": "some text"}],
            "explanation": "",
        })
        result = provider._parse_grade_response(response, "bool")
        quote = result["quotes"][0]
        assert quote["message_index"] == 2
        assert quote["start"] == 10
        assert quote["end"] == 20
        assert quote["text"] == "some text"

    def test_empty_quotes_ok(self):
        provider = self._get_provider()
        response = json.dumps({"grade": True, "quotes": [], "explanation": ""})
        result = provider._parse_grade_response(response, "bool")
        assert result["quotes"] == []

    def test_no_json_raises(self):
        provider = self._get_provider()
        with pytest.raises(ValueError, match="No JSON"):
            provider._parse_grade_response("This has no JSON at all", "bool")

    def test_malformed_json_raises(self):
        provider = self._get_provider()
        with pytest.raises(ValueError):
            provider._parse_grade_response("{grade: true, bad json}", "bool")


class TestGoogleProviderClientReuse:
    """Tests for GoogleProvider client caching."""

    def test_google_has_get_client_method(self):
        provider = GoogleProvider(api_key="test-key", model="gemini-2.5-pro")
        assert hasattr(provider, '_get_client')

    def test_google_get_client_returns_same_instance(self):
        """_get_client() returns the same GenerativeModel instance."""
        provider = GoogleProvider(api_key="test-key", model="gemini-2.5-pro")
        with patch('google.generativeai.configure'):
            with patch('google.generativeai.GenerativeModel') as MockModel:
                MockModel.return_value = MagicMock()
                client1 = provider._get_client()
                client2 = provider._get_client()
                assert client1 is client2

    def test_google_configure_called_every_time(self):
        """genai.configure() is called on every _get_client() to avoid global state races."""
        provider = GoogleProvider(api_key="test-key", model="gemini-2.5-pro")
        with patch('google.generativeai.configure') as mock_configure:
            with patch('google.generativeai.GenerativeModel'):
                provider._get_client()
                provider._get_client()
                provider._get_client()
                assert mock_configure.call_count == 3

    def test_google_client_cached_1000_calls_under_50ms(self):
        """1000 _get_client() calls complete quickly (configure called each time for safety)."""
        provider = GoogleProvider(api_key="test-key", model="gemini-2.5-pro")
        with patch('google.generativeai.configure'):
            with patch('google.generativeai.GenerativeModel'):
                provider._get_client()

                start = time.perf_counter()
                for _ in range(1000):
                    provider._get_client()
                elapsed = time.perf_counter() - start
                assert elapsed < 0.050, f"1000 calls took {elapsed:.6f}s, expected < 50ms"


class TestPresetMetrics:
    """Tests for PRESET_METRICS."""

    def test_has_five_entries(self):
        assert len(PRESET_METRICS) == 5

    def test_correct_keys(self):
        expected = {"helpfulness", "accuracy", "safety", "coherence", "task_completion"}
        assert set(PRESET_METRICS.keys()) == expected

    def test_helpfulness_is_float(self):
        assert PRESET_METRICS["helpfulness"]["grade_type"] == "float"

    def test_coherence_is_float(self):
        assert PRESET_METRICS["coherence"]["grade_type"] == "float"

    def test_accuracy_is_bool(self):
        assert PRESET_METRICS["accuracy"]["grade_type"] == "bool"

    def test_safety_is_bool(self):
        assert PRESET_METRICS["safety"]["grade_type"] == "bool"

    def test_task_completion_is_bool(self):
        assert PRESET_METRICS["task_completion"]["grade_type"] == "bool"

    def test_all_have_required_fields(self):
        for key, metric in PRESET_METRICS.items():
            assert "name" in metric, f"{key} missing name"
            assert "description" in metric, f"{key} missing description"
            assert "grade_type" in metric, f"{key} missing grade_type"
            assert "prompt" in metric, f"{key} missing prompt"
