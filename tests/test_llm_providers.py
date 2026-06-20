"""Tests for LLM provider factory, prompt building, response parsing, and preset metrics."""

import json
import time
from unittest.mock import patch, MagicMock, AsyncMock

import pytest
from backend.llm_providers import (
    get_provider,
    get_grading_provider,
    OpenAIProvider,
    AnthropicProvider,
    GoogleProvider,
    OpenRouterProvider,
    ModelRouterProvider,
    InvalidGradeResponse,
    LLMProvider,
    PRESET_METRICS,
    _format_target_conversation,
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


class TestModelRouterProvider:
    """Tests for model_router-backed grading helpers without network calls."""

    def test_normalizes_legacy_provider_model_names(self):
        assert (
            ModelRouterProvider(api_key="k", model="claude-opus-4-5", provider_name="anthropic")
            ._router_model_name()
            == "anthropic/claude-opus-4-5"
        )
        assert (
            ModelRouterProvider(api_key="k", model="gemini-2.5-pro", provider_name="google")
            ._router_model_name()
            == "gemini/gemini-2.5-pro"
        )
        assert (
            ModelRouterProvider(api_key="k", model="openai/gpt-4o", provider_name="openrouter")
            ._router_model_name()
            == "openrouter/openai/gpt-4o"
        )

    def test_build_payload_includes_budget_and_reasoning_effort(self):
        provider = ModelRouterProvider(
            api_key="k",
            model="gpt-5.5",
            provider_name="openai",
            max_tokens=32768,
            reasoning_effort="low",
            max_attempts=1,
        )
        formatted = _format_target_conversation([
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ])

        payload = provider._build_payload(
            formatted,
            metric_prompt="Is the assistant polite?",
            grade_type="bool",
            require_quotes=True,
            attempt=1,
            previous_error=None,
        )

        assert payload["sampling"]["max_tokens"] == 32768
        assert payload["sampling"]["reasoning_effort"] == "low"
        assert "temperature" not in payload["sampling"]

    def test_build_payload_forwards_explicit_temperature(self):
        provider = ModelRouterProvider(
            api_key="k",
            model="gpt-4o",
            provider_name="openai",
            temperature=0.25,
            max_attempts=1,
        )
        formatted = _format_target_conversation([
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ])

        payload = provider._build_payload(
            formatted,
            metric_prompt="Is the assistant polite?",
            grade_type="bool",
            require_quotes=True,
            attempt=1,
            previous_error=None,
        )

        assert payload["sampling"]["temperature"] == 0.25

    async def test_grade_sample_parses_tool_call_and_validates_quote(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        provider._post_step = AsyncMock(return_value={
            "decoded_message": {
                "tool_calls": [{
                    "function": {
                        "name": "submit_grade",
                        "arguments": {
                            "grade": True,
                            "grade_type": "bool",
                            "quotes": [{
                                "message_index": 1,
                                "channel": "text",
                                "start": 0,
                                "end": 8,
                                "text": "Hi there",
                            }],
                            "explanation": "The assistant greeted the user.",
                        },
                    },
                }],
            },
        })

        result = await provider.grade_sample(
            messages=[
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there"},
            ],
            metric_prompt="Is the assistant polite?",
            grade_type="bool",
            require_quotes=True,
        )

        assert result.grade is True
        assert result.model == "model_router:litellm:gpt-4o"
        assert result.quotes[0].channel == "text"
        assert result.quotes[0].text == "Hi there"

    def test_openai_grading_defaults_to_litellm(self):
        provider = get_grading_provider("openai", "test-key", "gpt-5.2")
        assert isinstance(provider, ModelRouterProvider)
        assert provider.router_provider == "litellm"
        assert provider._router_model_name() == "gpt-5.2"

    def test_non_openai_grading_defaults_to_litellm(self):
        provider = get_grading_provider("anthropic", "test-key", "claude-opus-4-5")
        assert isinstance(provider, ModelRouterProvider)
        assert provider.router_provider == "litellm"

    def test_invalid_env_router_provider_rejected(self, monkeypatch):
        monkeypatch.setenv("ROLLOUT_VIZ_MODEL_ROUTER_PROVIDER", "model_router")
        with pytest.raises(ValueError, match="ROLLOUT_VIZ_MODEL_ROUTER_PROVIDER"):
            ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai")

    async def test_missing_required_quote_rejected_on_non_final_attempt(self):
        # With max_attempts=2, attempt 1 is non-final and must raise to trigger a retry.
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=2)
        empty_quote_step = {
            "decoded_message": {
                "tool_calls": [{
                    "function": {
                        "name": "submit_grade",
                        "arguments": {
                            "grade": True,
                            "grade_type": "bool",
                            "quotes": [],
                            "explanation": "ok",
                        },
                    },
                }],
            },
        }
        provider._post_step = AsyncMock(return_value=empty_quote_step)
        # Suppress backoff sleeps for speed.
        with patch("backend.llm_providers.asyncio.sleep", new=AsyncMock()):
            # Final attempt (attempt 2) returns the grade with empty quotes instead of raising.
            result = await provider.grade_sample(
                messages=[{"role": "assistant", "content": "Hi"}],
                metric_prompt="metric",
                grade_type="bool",
                require_quotes=True,
            )
        assert result.grade is True
        assert result.quotes == []
        # Should have retried (2 attempts).
        assert provider._post_step.await_count == 2

    def test_normalize_quotes_raises_on_non_final_returns_on_final(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=2)
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi"}])
        # Non-final attempt: missing required quotes raises.
        with pytest.raises(InvalidGradeResponse, match="quote"):
            provider._normalize_quotes([], formatted, require_quotes=True, is_final=False)
        # Final attempt: returns empty list, no raise.
        assert provider._normalize_quotes([], formatted, require_quotes=True, is_final=True) == []

    async def test_rejected_grader_output_is_logged(self, capsys):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        provider._post_step = AsyncMock(return_value={
            "stop_reason": "length",
            "parse_success": True,
            "usage": {"completion_tokens": 4096},
            "decoded_message": {
                "role": "assistant",
                "content": "I need more room before I can call the tool.",
                "content_parts": [
                    {"type": "text", "text": "I need more room before I can call the tool."},
                ],
                "tool_calls": [],
                "openai_response_items": [
                    {"type": "reasoning", "summary": "thinking", "encrypted_content": "secret"},
                ],
            },
            "unparsed_tool_calls": [{"raw_text": "<submit_grade bad", "error": "bad xml"}],
        })

        with pytest.raises(InvalidGradeResponse, match="submit_grade"):
            await provider.grade_sample(
                messages=[{"role": "assistant", "content": "Hi"}],
                metric_prompt="metric",
                grade_type="bool",
                require_quotes=True,
            )

        captured = capsys.readouterr().out
        assert "grader output rejected" in captured
        assert "I need more room" in captured
        assert '"stop_reason": "length"' in captured
        assert "bad xml" in captured
        assert "encrypted_content" not in captured


def _step_with_args(args):
    return {
        "decoded_message": {
            "tool_calls": [{"function": {"name": "submit_grade", "arguments": args}}],
        },
    }


class TestEmptyExplanationAccepted:
    """P0: a schema-valid grade with empty explanation must not be dropped."""

    @pytest.mark.parametrize(
        "grade_type,grade",
        [("bool", True), ("int", 3), ("float", 0.5)],
    )
    def test_parse_step_result_accepts_empty_explanation(self, grade_type, grade):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi there"}])
        step = _step_with_args({
            "grade": grade,
            "grade_type": grade_type,
            "quotes": [{
                "message_index": 0,
                "channel": "text",
                "start": 0,
                "end": 8,
                "text": "Hi there",
            }],
            "explanation": "",
        })
        result = provider._parse_step_result(step, formatted, grade_type, require_quotes=True, is_final=True)
        assert result.grade == grade
        # A non-empty placeholder explanation is synthesized.
        assert result.explanation

    def test_freeform_empty_explanation_still_accepted(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi there"}])
        step = _step_with_args({
            "grade": "some summary",
            "grade_type": "freeform",
            "quotes": [],
            "explanation": "",
        })
        result = provider._parse_step_result(step, formatted, "freeform", require_quotes=False, is_final=True)
        assert result.grade == "some summary"


class TestSubmitGradeToolSchema:
    def test_required_no_longer_includes_explanation_or_grade_type(self):
        from backend.llm_providers import _submit_grade_tool
        required = _submit_grade_tool()["parameters"]["required"]
        assert "explanation" not in required
        assert "grade_type" not in required
        assert "grade" in required
        assert "quotes" in required


class TestQuoteWhitespaceFallback:
    def test_quote_with_collapsed_whitespace_matches(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        formatted = _format_target_conversation([
            {"role": "assistant", "content": "Hello   there\nfriend"},
        ])
        # Quote text uses single spaces / different whitespace than the channel.
        quotes = provider._normalize_quotes(
            [{"message_index": 0, "channel": "text", "start": 0, "end": 0, "text": "Hello there friend"}],
            formatted,
            require_quotes=True,
            is_final=False,
        )
        assert len(quotes) == 1


class TestReasoningEffortGating:
    def test_google_omits_reasoning_effort(self):
        provider = ModelRouterProvider(
            api_key="k", model="gemini-2.5-pro", provider_name="google",
            reasoning_effort="low", max_attempts=1,
        )
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi"}])
        payload = provider._build_payload(formatted, "m", "bool", False, 1, None)
        assert "reasoning_effort" not in payload["sampling"]

    def test_openai_includes_reasoning_effort(self):
        provider = ModelRouterProvider(
            api_key="k", model="gpt-5.5", provider_name="openai",
            reasoning_effort="low", max_attempts=1,
        )
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi"}])
        payload = provider._build_payload(formatted, "m", "bool", False, 1, None)
        assert payload["sampling"]["reasoning_effort"] == "low"


class TestToolCallSalvage:
    def test_fenced_json_arguments_parsed(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        args = '```json\n{"grade": true, "grade_type": "bool", "quotes": [], "explanation": "x"}\n```'
        payload = provider._extract_tool_payload(_step_with_args(args))
        assert payload["grade"] is True

    def test_payload_recovered_from_unparsed_tool_calls(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        step = {
            "decoded_message": {"tool_calls": []},
            "unparsed_tool_calls": [
                {"raw_text": '{"name": "submit_grade", "arguments": {"grade": true, "grade_type": "bool", "quotes": [], "explanation": "x"}}'},
            ],
        }
        payload = provider._extract_tool_payload(step)
        assert payload["grade"] is True

    def test_absent_submit_grade_still_raises(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        step = {"decoded_message": {"tool_calls": [], "content": "no tool"}}
        with pytest.raises(InvalidGradeResponse, match="submit_grade"):
            provider._extract_tool_payload(step)


class TestBackoffSkipForInvalidGrade:
    async def test_no_backoff_for_invalid_grade_response(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=2)
        # First attempt: model fails to call submit_grade (InvalidGradeResponse, non-final).
        # Second attempt: succeeds.
        good_step = _step_with_args({
            "grade": True, "grade_type": "bool",
            "quotes": [{"message_index": 0, "channel": "text", "start": 0, "end": 8, "text": "Hi there"}],
            "explanation": "ok",
        })
        bad_step = {"decoded_message": {"tool_calls": [], "content": "nope"}}
        provider._post_step = AsyncMock(side_effect=[bad_step, good_step])
        sleep_mock = AsyncMock()
        with patch("backend.llm_providers.asyncio.sleep", new=sleep_mock):
            result = await provider.grade_sample(
                messages=[{"role": "assistant", "content": "Hi there"}],
                metric_prompt="m",
                grade_type="bool",
                require_quotes=True,
            )
        assert result.grade is True
        # No backoff sleep should be taken for an InvalidGradeResponse retry.
        sleep_mock.assert_not_awaited()


class TestRetryNoteQuoteSpecific:
    def test_quote_error_produces_verbatim_instruction(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=2)
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi"}])
        prompt = provider._build_user_prompt(
            formatted, "m", "bool", True, attempt=2,
            previous_error="missing at least one valid supporting quote",
        )
        assert "verbatim" in prompt.lower()


class TestGradeCoercionTolerance:
    def test_bool_with_trailing_punctuation(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        assert provider._coerce_grade("True.", "bool") is True
        assert provider._coerce_grade("yes", "bool") is True
        assert provider._coerce_grade("Fail!", "bool") is False

    def test_ambiguous_bool_still_raises(self):
        provider = ModelRouterProvider(api_key="k", model="gpt-4o", provider_name="openai", max_attempts=1)
        with pytest.raises(InvalidGradeResponse):
            provider._coerce_grade("likely", "bool")


class TestMissingKeyError:
    def test_google_missing_key_raises_named_error(self):
        provider = ModelRouterProvider(api_key="", model="gemini-2.5-pro", provider_name="google", max_attempts=1)
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi"}])
        with pytest.raises(RuntimeError, match="google"):
            provider._build_payload(formatted, "m", "bool", False, 1, None)

    def test_openai_no_key_does_not_raise(self):
        # openai relies on server-side router keys; api_key may legitimately be empty.
        provider = ModelRouterProvider(api_key="", model="gpt-4o", provider_name="openai", max_attempts=1)
        formatted = _format_target_conversation([{"role": "assistant", "content": "Hi"}])
        payload = provider._build_payload(formatted, "m", "bool", False, 1, None)
        assert payload["api_key"] is None


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
