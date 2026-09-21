import json
from pathlib import Path

from jsonschema import Draft202012Validator

import madhusudan_voice
from madhusudan_voice.request_tool import SERVER_FIELDS, render, tool_parameters
from madhusudan_voice.request_tool_schema import TOOL_PARAMETERS

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_embedded_tool_schema_is_derived_from_the_api_contract():
    derived = tool_parameters(load(CONTRACTS / "json-schema" / "demo-v1" / "create-request.json"))
    assert TOOL_PARAMETERS == derived, "regenerate: python -m madhusudan_voice.request_tool <create-request.json>"
    generated = Path(madhusudan_voice.__file__).with_name("request_tool_schema.py").read_text(encoding="utf-8")
    assert generated == render(derived)


def test_the_model_is_offered_every_journey_with_its_exact_fields():
    Draft202012Validator.check_schema(TOOL_PARAMETERS)
    branches = TOOL_PARAMETERS["properties"]["request"]["anyOf"]
    assert {branch["properties"]["journey"]["const"] for branch in branches} == {"CONSUMER_COMPLAINT", "RETAILER_ENQUIRY", "DISTRIBUTOR_CASE", "SALES_LEAD"}
    for branch in branches:
        assert branch["additionalProperties"] is False
        assert not set(SERVER_FIELDS) & set(branch["properties"])
        assert branch["properties"]["fields"]["required"]


def test_every_valid_request_in_the_shared_corpus_is_valid_tool_input():
    corpus = load(CONTRACTS / "fixtures" / "demo-journeys" / "corpus.json")
    requests = [load(CONTRACTS / "fixtures" / "demo-journeys" / item["file"]) if "file" in item else item["payload"]
        for item in corpus["valid"] if item["schema"] == "CreateRequestInput"]
    assert requests
    validator = Draft202012Validator(TOOL_PARAMETERS)
    for request in requests:
        arguments = {"request": {key: value for key, value in request.items() if key not in SERVER_FIELDS}}
        assert not list(validator.iter_errors(arguments)), request["journey"]


def test_free_form_arguments_are_not_valid_tool_input():
    validator = Draft202012Validator(TOOL_PARAMETERS)
    assert list(validator.iter_errors({"request": {"description": "Leaking oil"}}))
    assert list(validator.iter_errors({"description": "Leaking oil"}))
