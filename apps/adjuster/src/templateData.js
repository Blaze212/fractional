function loadEnums() {
  var file = DriveApp.getFileById(getConfig('ENUMS_FILE_ID'))
  return JSON.parse(file.getBlob().getDataAsString())
}

function loadGlossary() {
  var file = DriveApp.getFileById(getConfig('GLOSSARY_FILE_ID'))
  return JSON.parse(file.getBlob().getDataAsString())
}

// One-time migration (2026-08-22): pushes the repo's template/enums.json
// content onto the live ENUMS_FILE_ID Drive file after the exterior/roof
// schema restructure (single narrative fields -> fixed per-elevation/per-slope
// fields). Run once from the editor, then delete this function — it is a
// point-in-time snapshot, not something that stays in sync on its own.
function syncEnumsFileFromRepo_20260822() {
  var json = `{
  "contacted_party_name": {
    "label": "Contacted party",
    "type": "string",
    "section": "Assignment",
    "required": true
  },
  "present_at_inspection": {
    "label": "Present at inspection",
    "type": "string",
    "section": "Assignment",
    "required": true
  },
  "present_at_inspection_verb": {
    "label": "Present at inspection — was/were",
    "type": "enum",
    "section": "Assignment",
    "required": true,
    "values": ["was", "were"]
  },
  "mortgage_status": {
    "label": "Mortgage status",
    "type": "variant",
    "section": "Mortgage",
    "required": true,
    "values": [
      {
        "key": "has_mortgage",
        "label": "Has a mortgage",
        "text": "I confirmed with [XM8_INSURED_NAME] that their mortgage is through [XM8_MORTGAGEE1]."
      },
      {
        "key": "no_mortgage",
        "label": "No mortgage",
        "text": "There is not a mortgage on the property."
      }
    ]
  },
  "origin_narrative": {
    "label": "Cause of loss",
    "type": "narrative",
    "section": "Origin",
    "required": true
  },
  "origin_damage_narrative": {
    "label": "Resulting damage (what was damaged)",
    "type": "narrative",
    "section": "Origin",
    "required": true
  },
  "coverage_cause_narrative": {
    "label": "Coverage cause clause (e.g. \\"storm related\\", \\"related to a burst plumbing line due to freezing\\")",
    "type": "narrative",
    "section": "Coverage",
    "required": true
  },
  "coverage_determination": {
    "label": "Coverage determination",
    "type": "variant",
    "section": "Coverage",
    "required": true,
    "values": [
      {
        "key": "covered",
        "label": "Covered, no concerns",
        "text": "which is covered under the insured's policy. {{coverage_supporting_detail}} Therefore, there are no coverage concerns that would affect this claim."
      },
      {
        "key": "excluded",
        "label": "Excluded / coverage does not apply",
        "text": "which is excluded under the insured's policy. {{coverage_supporting_detail}} Therefore, coverage does not appear to be applicable to this loss."
      }
    ]
  },
  "coverage_supporting_detail": {
    "label": "Coverage supporting detail (optional, e.g. confirming heat was maintained for a freeze claim)",
    "type": "narrative",
    "section": "Coverage",
    "required": false
  },
  "dwelling_type": {
    "label": "Dwelling type",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["single family", "duplex", "multi family"]
  },
  "dwelling_stories": {
    "label": "Dwelling stories",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["1 story", "2 story", "3 story", "4 story"]
  },
  "year_built": {
    "label": "Year built",
    "type": "string",
    "section": "Risk",
    "required": false
  },
  "foundation_type": {
    "label": "Foundation type",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["crawlspace", "basement", "slab"]
  },
  "siding_type": {
    "label": "Siding type",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": [
      "vinyl siding",
      "stucco siding",
      "a brick veneer",
      "steel siding",
      "aluminum siding",
      "wood siding",
      "fiber board siding",
      "vertical wood siding",
      "cedar wood siding",
      "hardiplank siding",
      "fiber cement siding"
    ]
  },
  "square_footage": {
    "label": "Interior square footage",
    "type": "string",
    "section": "Risk",
    "required": true
  },
  "bedroom_count": {
    "label": "Bedroom count",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["1", "2", "3", "4", "5", "6"]
  },
  "bathroom_count": {
    "label": "Bathroom count",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["1", "2", "3", "4", "5", "6"]
  },
  "occupancy_status": {
    "label": "Occupancy",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["the insured", "a tenant", "tenants"]
  },
  "roof_status": {
    "label": "Roof status",
    "type": "variant",
    "section": "Roof",
    "required": true,
    "values": [
      {
        "key": "not_affected",
        "label": "Not affected",
        "text": "The dwelling roof was not affected during this loss."
      },
      {
        "key": "shingle",
        "label": "Affected, shingle roof",
        "text": "The shingles on the roof are a {{roof_covering_type}} that are approximately {{roof_age_years}} years old. The shingles are in {{roof_condition}} condition for their age. There is one layer of shingles with no drip edge present. The slopes on the roof are pitched at {{roof_pitch}}.\\nMy inspection of the roof found the following:\\nSoft metals: {{roof_soft_metals}}\\nFront slope: {{roof_front_slope}}\\nRight slope: {{roof_right_slope}}\\nBack slope: {{roof_back_slope}}\\nLeft slope: {{roof_left_slope}}"
      },
      {
        "key": "other_material",
        "label": "Affected, non-shingle roof",
        "text": "{{roof_narrative_freeform}}"
      }
    ]
  },
  "roof_covering_type": {
    "label": "Roof covering type (shingle)",
    "type": "enum",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" },
    "values": [
      "20 year 3 tab shingles",
      "25 year 3 tab shingles",
      "30 year laminate shingles",
      "40 year laminate shingles",
      "50 year laminate shingles",
      "Wood shingles",
      "Cedar shakes"
    ]
  },
  "roof_condition": {
    "label": "Shingle condition",
    "type": "enum",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" },
    "values": ["average", "below average"]
  },
  "roof_age_years": {
    "label": "Roof age (years)",
    "type": "string",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" }
  },
  "roof_pitch": {
    "label": "Roof pitch",
    "type": "enum",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" },
    "values": [
      "1/12",
      "2/12",
      "3/12",
      "4/12",
      "5/12",
      "6/12",
      "7/12",
      "8/12",
      "9/12",
      "10/12",
      "12/12",
      "greater than 12/12"
    ]
  },
  "roof_soft_metals": {
    "label": "Roof findings — soft metals (drip edge, flashing, vents, gutters)",
    "type": "narrative",
    "section": "Roof",
    "required": false
  },
  "roof_front_slope": {
    "label": "Roof findings — front slope",
    "type": "narrative",
    "section": "Roof",
    "required": false
  },
  "roof_right_slope": {
    "label": "Roof findings — right slope",
    "type": "narrative",
    "section": "Roof",
    "required": false
  },
  "roof_back_slope": {
    "label": "Roof findings — back slope",
    "type": "narrative",
    "section": "Roof",
    "required": false
  },
  "roof_left_slope": {
    "label": "Roof findings — left slope",
    "type": "narrative",
    "section": "Roof",
    "required": false
  },
  "roof_narrative_freeform": {
    "label": "Roof findings, non-shingle material (full narrative — material, age, condition, layers, pitch, per-slope findings, conclusion)",
    "type": "narrative",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "other_material" }
  },
  "exterior_status": {
    "label": "Exterior status",
    "type": "variant",
    "section": "Exterior",
    "required": true,
    "values": [
      {
        "key": "not_affected",
        "label": "Not affected",
        "text": "The dwelling exterior was not affected during this loss."
      },
      {
        "key": "affected",
        "label": "Affected",
        "text": "Inspection of the elevations around the dwelling found the following:\\nFront elevation: {{exterior_front_elevation}}\\nRight elevation: {{exterior_right_elevation}}\\nBack elevation: {{exterior_back_elevation}}\\nLeft elevation: {{exterior_left_elevation}}"
      }
    ]
  },
  "exterior_front_elevation": {
    "label": "Exterior findings — front elevation",
    "type": "narrative",
    "section": "Exterior",
    "required": false
  },
  "exterior_right_elevation": {
    "label": "Exterior findings — right elevation",
    "type": "narrative",
    "section": "Exterior",
    "required": false
  },
  "exterior_back_elevation": {
    "label": "Exterior findings — back elevation",
    "type": "narrative",
    "section": "Exterior",
    "required": false
  },
  "exterior_left_elevation": {
    "label": "Exterior findings — left elevation",
    "type": "narrative",
    "section": "Exterior",
    "required": false
  },
  "interior_damage_narrative": {
    "label": "Interior damage findings",
    "type": "narrative",
    "section": "Interior",
    "required": false
  },
  "personal_property_status": {
    "label": "Personal property status",
    "type": "variant",
    "section": "Personal Property",
    "required": true,
    "values": [
      {
        "key": "none",
        "label": "No damage",
        "text": "Inspection found no event related damages to any of the insured's personal property."
      },
      {
        "key": "damaged",
        "label": "Damaged",
        "text": "{{personal_property_narrative}}\\n\\n[NEEDS INPUT: Confirm personal property list above against the transcript before filing.]"
      }
    ]
  },
  "personal_property_narrative": {
    "label": "Personal property damage findings",
    "type": "narrative",
    "section": "Personal Property",
    "required": true,
    "requiredWhen": { "field": "personal_property_status", "equals": "damaged" }
  },
  "mitigation_status": {
    "label": "Mitigation status",
    "type": "variant",
    "section": "Mitigation",
    "required": true,
    "values": [
      { "key": "none", "label": "No mitigation vendor involved", "text": "" },
      {
        "key": "present",
        "label": "Mitigation vendor involved",
        "text": "MITIGATION:\\n{{mitigation_narrative}}"
      }
    ]
  },
  "mitigation_narrative": {
    "label": "Mitigation details",
    "type": "narrative",
    "section": "Mitigation",
    "required": true,
    "requiredWhen": { "field": "mitigation_status", "equals": "present" }
  },
  "overhead_profit_narrative": {
    "label": "Overhead & profit determination",
    "type": "narrative",
    "section": "Overhead & Profit",
    "required": true
  },
  "subrogation_reason": {
    "label": "Subrogation reason clause (e.g. \\"weather related\\", \\"related to a 10 year old plumbing supply line that was not recently repaired\\")",
    "type": "narrative",
    "section": "Salvage & Subrogation",
    "required": true
  },
  "coinsurance_narrative": {
    "label": "Coinsurance — no coinsurance penalty applies in most claims; confirm figures with Brandon if this one does",
    "type": "narrative",
    "section": "Coinsurance",
    "required": true
  }
}
`
  var file = DriveApp.getFileById(getConfig('ENUMS_FILE_ID'))
  file.setContent(json)
  logEvent('enums.synced_from_repo', { bytes: json.length, file_id: file.getId() })
  return 'done'
}

// One-time migration (2026-08-27): pushes the repo's template/enums.json
// content onto the live ENUMS_FILE_ID Drive file after removing
// present_at_inspection_verb, loosening dwelling_stories off a strict enum,
// requiring year_built and the per-slope/per-elevation status fields, and
// adding coinsurance_status. Run once from the editor, then delete this
// function — it is a point-in-time snapshot, not something that stays in
// sync on its own.
function syncEnumsFileFromRepo_20260827b() {
  var json = `{
  "contacted_party_name": {
    "label": "Contacted party",
    "type": "string",
    "section": "Assignment",
    "required": true
  },
  "present_at_inspection": {
    "label": "Present at inspection",
    "type": "narrative",
    "section": "Assignment",
    "required": true
  },
  "mortgage_status": {
    "label": "Mortgage status",
    "type": "variant",
    "section": "Mortgage",
    "required": true,
    "values": [
      {
        "key": "has_mortgage",
        "label": "Has a mortgage",
        "text": "I confirmed with [XM8_INSURED_NAME] that their mortgage is through [XM8_MORTGAGEE1]."
      },
      {
        "key": "no_mortgage",
        "label": "No mortgage",
        "text": "There is not a mortgage on the property."
      }
    ]
  },
  "origin_narrative": {
    "label": "Cause of loss",
    "type": "narrative",
    "section": "Origin",
    "required": true
  },
  "origin_damage_narrative": {
    "label": "Resulting damage (what was damaged)",
    "type": "narrative",
    "section": "Origin",
    "required": true
  },
  "coverage_cause_narrative": {
    "label": "Coverage cause clause (e.g. \\"storm related\\", \\"related to a burst plumbing line due to freezing\\")",
    "type": "narrative",
    "section": "Coverage",
    "required": true
  },
  "coverage_determination": {
    "label": "Coverage determination",
    "type": "variant",
    "section": "Coverage",
    "required": true,
    "values": [
      {
        "key": "covered",
        "label": "Covered, no concerns",
        "text": "which is covered under the insured's policy. {{coverage_supporting_detail}} Therefore, there are no coverage concerns that would affect this claim."
      },
      {
        "key": "excluded",
        "label": "Excluded / coverage does not apply",
        "text": "which is excluded under the insured's policy. {{coverage_supporting_detail}} Therefore, coverage does not appear to be applicable to this loss."
      }
    ]
  },
  "coverage_supporting_detail": {
    "label": "Coverage supporting detail (optional, e.g. confirming heat was maintained for a freeze claim)",
    "type": "narrative",
    "section": "Coverage",
    "required": false
  },
  "dwelling_type": {
    "label": "Dwelling type",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["single family", "duplex", "multi family"]
  },
  "dwelling_stories": {
    "label": "Dwelling stories",
    "type": "string",
    "section": "Risk",
    "required": true
  },
  "year_built": {
    "label": "Year built",
    "type": "string",
    "section": "Risk",
    "required": true
  },
  "foundation_type": {
    "label": "Foundation type",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["crawlspace", "basement", "slab"]
  },
  "siding_type": {
    "label": "Siding type",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": [
      "vinyl siding",
      "stucco siding",
      "a brick veneer",
      "steel siding",
      "aluminum siding",
      "wood siding",
      "fiber board siding",
      "vertical wood siding",
      "cedar wood siding",
      "hardiplank siding",
      "fiber cement siding"
    ]
  },
  "square_footage": {
    "label": "Interior square footage",
    "type": "string",
    "section": "Risk",
    "required": true
  },
  "bedroom_count": {
    "label": "Bedroom count",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["1", "2", "3", "4", "5", "6"]
  },
  "bathroom_count": {
    "label": "Bathroom count",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["1", "2", "3", "4", "5", "6"]
  },
  "occupancy_status": {
    "label": "Occupancy",
    "type": "enum",
    "section": "Risk",
    "required": true,
    "values": ["the insured", "a tenant", "tenants"]
  },
  "roof_status": {
    "label": "Roof status",
    "type": "variant",
    "section": "Roof",
    "required": true,
    "values": [
      {
        "key": "not_affected",
        "label": "Not affected",
        "text": "The dwelling roof was not affected during this loss."
      },
      {
        "key": "shingle",
        "label": "Affected, shingle roof",
        "text": "The shingles on the roof are a {{roof_covering_type}} that are approximately {{roof_age_years}} years old. The shingles are in {{roof_condition}} condition for their age. There is one layer of shingles with no drip edge present. The slopes on the roof are pitched at {{roof_pitch}}."
      },
      {
        "key": "other_material",
        "label": "Affected, non-shingle roof",
        "text": "{{roof_narrative_freeform}}"
      }
    ]
  },
  "roof_covering_type": {
    "label": "Roof covering type (shingle)",
    "type": "enum",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" },
    "values": [
      "20 year 3 tab shingles",
      "25 year 3 tab shingles",
      "30 year laminate shingles",
      "40 year laminate shingles",
      "50 year laminate shingles",
      "Wood shingles",
      "Cedar shakes"
    ]
  },
  "roof_condition": {
    "label": "Shingle condition",
    "type": "enum",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" },
    "values": ["average", "below average"]
  },
  "roof_age_years": {
    "label": "Roof age (years)",
    "type": "string",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" }
  },
  "roof_pitch": {
    "label": "Roof pitch",
    "type": "enum",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "shingle" },
    "values": [
      "1/12",
      "2/12",
      "3/12",
      "4/12",
      "5/12",
      "6/12",
      "7/12",
      "8/12",
      "9/12",
      "10/12",
      "12/12",
      "greater than 12/12"
    ]
  },
  "soft_metal_status": {
    "label": "Soft metals status (drip edge, flashing, vents, gutters)",
    "type": "narrative",
    "section": "Roof",
    "required": true
  },
  "front_slope_status": {
    "label": "Front slope status",
    "type": "narrative",
    "section": "Roof",
    "required": true
  },
  "right_slope_status": {
    "label": "Right slope status",
    "type": "narrative",
    "section": "Roof",
    "required": true
  },
  "back_slope_status": {
    "label": "Back slope status",
    "type": "narrative",
    "section": "Roof",
    "required": true
  },
  "left_slope_status": {
    "label": "Left slope status",
    "type": "narrative",
    "section": "Roof",
    "required": true
  },
  "roof_narrative_freeform": {
    "label": "Roof findings, non-shingle material (full narrative — material, age, condition, layers, pitch, per-slope findings, conclusion)",
    "type": "narrative",
    "section": "Roof",
    "required": true,
    "requiredWhen": { "field": "roof_status", "equals": "other_material" }
  },
  "exterior_status": {
    "label": "Exterior status",
    "type": "variant",
    "section": "Exterior",
    "required": true,
    "values": [
      {
        "key": "not_affected",
        "label": "Not affected",
        "text": "The dwelling exterior was not affected during this loss."
      },
      {
        "key": "affected",
        "label": "Affected",
        "text": "The dwelling exterior was affected during this loss."
      }
    ]
  },
  "front_elevation_status": {
    "label": "Front elevation status",
    "type": "narrative",
    "section": "Exterior",
    "required": true
  },
  "right_elevation_status": {
    "label": "Right elevation status",
    "type": "narrative",
    "section": "Exterior",
    "required": true
  },
  "back_elevation_status": {
    "label": "Back elevation status",
    "type": "narrative",
    "section": "Exterior",
    "required": true
  },
  "left_elevation_status": {
    "label": "Left elevation status",
    "type": "narrative",
    "section": "Exterior",
    "required": true
  },
  "interior_damage_narrative": {
    "label": "Interior damage findings",
    "type": "narrative",
    "section": "Interior",
    "required": false
  },
  "personal_property_status": {
    "label": "Personal property status",
    "type": "variant",
    "section": "Personal Property",
    "required": true,
    "values": [
      {
        "key": "none",
        "label": "No damage",
        "text": "Inspection found no event related damages to any of the insured's personal property."
      },
      {
        "key": "damaged",
        "label": "Damaged",
        "text": "{{personal_property_narrative}}\\n\\n[NEEDS INPUT: Confirm personal property list above against the transcript before filing.]"
      }
    ]
  },
  "personal_property_narrative": {
    "label": "Personal property damage findings",
    "type": "narrative",
    "section": "Personal Property",
    "required": true,
    "requiredWhen": { "field": "personal_property_status", "equals": "damaged" }
  },
  "mitigation_status": {
    "label": "Mitigation status",
    "type": "variant",
    "section": "Mitigation",
    "required": true,
    "values": [
      { "key": "none", "label": "No mitigation vendor involved", "text": "" },
      {
        "key": "present",
        "label": "Mitigation vendor involved",
        "text": "MITIGATION:\\n{{mitigation_narrative}}"
      }
    ]
  },
  "mitigation_narrative": {
    "label": "Mitigation details",
    "type": "narrative",
    "section": "Mitigation",
    "required": true,
    "requiredWhen": { "field": "mitigation_status", "equals": "present" }
  },
  "overhead_profit_narrative": {
    "label": "Overhead & profit determination",
    "type": "narrative",
    "section": "Overhead & Profit",
    "required": true
  },
  "subrogation_reason": {
    "label": "Subrogation reason clause (e.g. \\"weather related\\", \\"related to a 10 year old plumbing supply line that was not recently repaired\\")",
    "type": "narrative",
    "section": "Salvage & Subrogation",
    "required": true
  },
  "coinsurance_status": {
    "label": "Coinsurance status",
    "type": "variant",
    "section": "Coinsurance",
    "required": true,
    "values": [
      {
        "key": "no_coinsurance",
        "label": "No coinsurance penalty applies",
        "text": "There is no coinsurance penalty applicable to this loss."
      },
      {
        "key": "applies",
        "label": "Coinsurance penalty applies",
        "text": "{{coinsurance_narrative}}"
      }
    ]
  },
  "coinsurance_narrative": {
    "label": "Coinsurance — figures/penalty details; confirm with Brandon",
    "type": "narrative",
    "section": "Coinsurance",
    "required": true,
    "requiredWhen": { "field": "coinsurance_status", "equals": "applies" }
  }
}`
  var file = DriveApp.getFileById(getConfig('ENUMS_FILE_ID'))
  file.setContent(json)
  logEvent('enums.synced_from_repo', { bytes: json.length, file_id: file.getId() })
  return 'done'
}
