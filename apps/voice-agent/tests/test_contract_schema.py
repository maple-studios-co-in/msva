import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_DIRECTORY = REPOSITORY_ROOT / "packages" / "contracts" / "fixtures" / "demo-journeys"
SCHEMA_DIRECTORY = REPOSITORY_ROOT / "packages" / "contracts" / "json-schema" / "demo-v1"

SCHEMA_FILES = {
    "Language": "language.json",
    "JourneyKind": "journey-kind.json",
    "TruthState": "truth-state.json",
    "IdentityAssurance": "identity-assurance.json",
    "CreateRequestInput": "create-request.json",
    "CreateRequestResult": "create-request-result.json",
    "DemoError": "demo-error.json",
    "CallerContextInput": "caller-context-input.json",
    "CallerContext": "caller-context.json",
    "SourceResult": "source-result.json",
    "Evidence": "evidence.json",
    "Handoff": "handoff.json",
    "RiskAssessment": "risk-assessment.json",
}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_payload(item: dict):
    if "file" in item:
        return load_json(FIXTURE_DIRECTORY / item["file"])
    return item["payload"]


def validator_for(schema_name: str) -> Draft202012Validator:
    schema = load_json(SCHEMA_DIRECTORY / SCHEMA_FILES[schema_name])
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


@pytest.fixture(scope="module")
def corpus():
    return load_json(FIXTURE_DIRECTORY / "corpus.json")


def test_checked_in_canonical_schemas_are_valid():
    for schema_name in SCHEMA_FILES:
        validator_for(schema_name)


def test_shared_positive_corpus_validates(corpus):
    for item in corpus["valid"]:
        errors = list(validator_for(item["schema"]).iter_errors(load_payload(item)))
        assert not errors, item.get("file", item["schema"])


def test_shared_negative_corpus_rejects(corpus):
    for item in corpus["invalid"]:
        errors = list(validator_for(item["schema"]).iter_errors(load_payload(item)))
        assert errors, item["name"]
