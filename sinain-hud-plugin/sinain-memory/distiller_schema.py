"""Distiller output schema — Phase B.4.5 Stage 2.

Defines the Pydantic v2 models that the rewritten distiller SYSTEM_PROMPT
targets. Same schema is consumed by knowledge_integrator (production write path)
and the bench harness (measurement path). Differ only in retry policy, not shape.

Design intent (from docs/memory-vs-semantic-web.md § "What to adopt NOW"):
- entities[] are typed nodes with schema.org class strings and SKOS-style altLabels
- facts[] are explicit subject-predicate-object triples (not free-text sentences)
- Cross-references between facts and entities are validated structurally

Migration boundary: the *top-level* envelope keeps whatHappened / decisions /
patterns / preferences / isEmpty from the legacy schema, so downstream consumers
that read those fields (knowledge_integrator's playbook curation, eval reporters)
continue working. Only `facts` and `entities` shapes change.

The validators are deliberately lenient on first introduction:
- Unknown schema.org types are accepted (we'll tighten as data accrues)
- altLabels is optional but list-typed (the prompt encourages but doesn't enforce non-empty)
- proper-noun detection is a downstream concern, not a structural check here

Strict-mode bench harness layers tighter checks on top via validate_strict().
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# Schema.org type strings we expect the distiller to emit. Not exhaustive — anything
# not in this set is accepted as a custom type but flagged in strict mode.
SCHEMA_ORG_TYPES = frozenset({
    "schema:Person",
    "schema:Organization",
    "schema:SoftwareApplication",
    "schema:CreativeWork",
    "schema:Event",
    "schema:Place",
    "schema:Product",
    "schema:Project",
    "schema:Service",
    "schema:File",
    "schema:Concept",
    "schema:Action",
    "schema:Quantity",
    "schema:Date",
})

# Slug pattern for entity IDs — lowercase, alphanumerics, hyphens, optional namespace prefix.
ID_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-_:.]*$")


class EntityModel(BaseModel):
    """A typed entity with display name, schema.org class, and SKOS-style aliases."""

    model_config = ConfigDict(extra="allow")  # permit jobTitle/description/etc.

    id: str = Field(..., min_length=1, description="Lowercase-hyphenated slug — canonical reference key")
    name: str = Field(..., min_length=1, description="Display name (e.g., 'Citibank')")
    type: str = Field(..., min_length=1, description="schema.org class (e.g., 'schema:Organization')")
    altLabels: list[str] = Field(default_factory=list, description="Synonyms / alternate names — SKOS altLabel")

    @field_validator("id")
    @classmethod
    def _id_is_slug(cls, v: str) -> str:
        if not ID_SLUG_RE.match(v):
            raise ValueError(f"entity id {v!r} must be lowercase slug (a-z, 0-9, -_:.)")
        return v

    @field_validator("altLabels")
    @classmethod
    def _altlabels_dedup_nonempty(cls, v: list[str]) -> list[str]:
        seen: set[str] = set()
        cleaned: list[str] = []
        for label in v:
            s = label.strip()
            if s and s not in seen:
                cleaned.append(s)
                seen.add(s)
        return cleaned


class FactModel(BaseModel):
    """A subject-predicate-object triple.

    `value_type` tells the integrator whether `object` is an entity reference
    (must resolve in PayloadModel.entities) or a literal value (string,
    date, number-as-string).
    """

    model_config = ConfigDict(extra="allow")

    subject: str = Field(..., min_length=1, description="Entity id from PayloadModel.entities")
    predicate: str = Field(..., min_length=1, description="Domain relation (schema:worksFor, etc.)")
    object: str = Field(..., min_length=1, description="Entity id (ref) or literal string")
    value_type: Literal["ref", "literal"] = Field(
        default="literal",
        description="'ref' → object resolves in PayloadModel.entities; 'literal' → opaque value",
    )
    confidence: float = Field(default=0.9, ge=0.0, le=1.0)

    @field_validator("subject")
    @classmethod
    def _subject_is_slug(cls, v: str) -> str:
        if not ID_SLUG_RE.match(v):
            raise ValueError(f"fact subject {v!r} must be lowercase slug")
        return v


class PayloadModel(BaseModel):
    """Top-level distiller output envelope.

    Backward-compatible with the legacy schema on `whatHappened`/`decisions`/
    `patterns`/`preferences`/`isEmpty` — only `facts` and `entities` shapes change.
    """

    model_config = ConfigDict(extra="allow")  # permit ts/sessionKey/etc. added by main()

    whatHappened: str = Field(default="", description="2-3 sentence session summary")
    facts: list[FactModel] = Field(default_factory=list)
    entities: list[EntityModel] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list, description="Decision sentences (legacy shape)")
    patterns: list[str] = Field(default_factory=list, description="Reusable techniques (legacy shape)")
    preferences: list[str] = Field(default_factory=list, description="User preferences/habits (legacy shape)")
    isEmpty: bool = Field(default=False)

    @model_validator(mode="after")
    def _check_references(self) -> "PayloadModel":
        """Every fact.subject and (fact.object if value_type='ref') must resolve in entities."""
        entity_ids = {e.id for e in self.entities}
        errors: list[str] = []
        for i, f in enumerate(self.facts):
            if f.subject not in entity_ids:
                errors.append(
                    f"fact[{i}].subject={f.subject!r} does not resolve to a declared entity"
                )
            if f.value_type == "ref" and f.object not in entity_ids:
                errors.append(
                    f"fact[{i}].object={f.object!r} declared as ref but not in entities"
                )
        if errors:
            raise ValueError("; ".join(errors))
        return self


# ===== Validation entry points =====

class ValidationResult(BaseModel):
    """Lenient-mode return shape: tells caller what passed and what warned."""

    ok: bool
    payload: PayloadModel | None = None
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def validate_strict(raw: dict) -> PayloadModel:
    """Bench-mode validator: raises on any structural failure.

    Use this in eval/benchmarks/ harness paths where we want to surface every
    distiller misbehavior. Pair with retry_on_validation_failure logic (max 5
    retries) to characterize residual failure rates.
    """
    return PayloadModel.model_validate(raw)


def validate_lenient(raw: dict) -> ValidationResult:
    """Production-mode validator: never raises, returns structured result.

    Use this in knowledge_integrator's production write path. On failure, the
    integrator logs the result and accepts partial data (today's behavior) —
    never blocks the pipeline. The whole purpose is to surface what failed
    without changing the existing failure mode of "drop on error, continue."
    """
    try:
        payload = PayloadModel.model_validate(raw)
        return ValidationResult(ok=True, payload=payload)
    except Exception as e:
        # Attempt salvage: drop facts that fail cross-reference, keep the rest.
        warnings: list[str] = []
        salvaged = dict(raw)
        if isinstance(raw, dict) and "facts" in raw and "entities" in raw:
            try:
                entity_ids = {
                    e["id"] for e in raw.get("entities", [])
                    if isinstance(e, dict) and "id" in e
                }
                kept_facts = []
                for f in raw.get("facts", []):
                    if not isinstance(f, dict):
                        continue
                    if f.get("subject") not in entity_ids:
                        warnings.append(f"dropped fact with unresolved subject {f.get('subject')!r}")
                        continue
                    if f.get("value_type") == "ref" and f.get("object") not in entity_ids:
                        warnings.append(f"dropped fact with unresolved object {f.get('object')!r}")
                        continue
                    kept_facts.append(f)
                salvaged["facts"] = kept_facts
                payload = PayloadModel.model_validate(salvaged)
                return ValidationResult(ok=True, payload=payload, warnings=warnings)
            except Exception as inner:
                return ValidationResult(ok=False, errors=[str(e), f"salvage_failed: {inner}"], warnings=warnings)
        return ValidationResult(ok=False, errors=[str(e)], warnings=warnings)


def has_schema_org_type(entity: EntityModel) -> bool:
    """Strict-mode check: did the distiller use a recognized schema.org type?"""
    return entity.type in SCHEMA_ORG_TYPES


def proper_noun_heuristic(name: str) -> bool:
    """Heuristic: is this entity a proper noun (and therefore should have altLabels)?

    A proper noun is signaled by: capitalized first letter in the display name,
    OR contains a digit pattern (like "Phase B.4.5" — version-y proper nouns),
    OR is multi-word with at least one capitalized word.
    """
    if not name:
        return False
    if name[0].isupper():
        return True
    if any(c.isdigit() for c in name) and any(c.isupper() for c in name):
        return True
    return False
