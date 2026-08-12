# Public source catalogue

The machine-readable catalogue is [`config/source-catalog.json`](../config/source-catalog.json). “Integrated” means an adapter or direct input path exists; it does not mean every dataset is complete, current, licensed for redistribution, or available at every park.

## Authoritative planning portals

| Park | Official portal | Role |
|---|---|---|
| Chessington World of Adventures | [Kingston planning applications](https://www.kingston.gov.uk/planning-and-building-control/planning-applications/search-or-comment) | Current and archived planning documents |
| Alton Towers Resort | [Staffordshire Moorlands public access](https://publicaccess.staffsmoorlands.gov.uk/portal/servlets/ApplicationSearchServlet) | Current and archived planning documents |
| LEGOLAND Windsor Resort | [RBWM planning search](https://www.rbwm.gov.uk/planning-and-building-control/find-planning-application) | Current and archived planning documents |
| Thorpe Park | [Runnymede planning applications](https://www.runnymede.gov.uk/planning-permission/view-object-support-application-1) | Current and archived planning documents |
| Drayton Manor | [Lichfield planning search](https://planning.lichfielddc.gov.uk/online-applications/search.do?action=simple) | Current and archived planning documents |

Council registers and their drawings are the authoritative records. The automatic workflow uses Idox, legacy Idox and Northgate adapters plus official application seeds; it caches bounded responses and records access failures without bypassing council controls.

## Automatic application discovery

| Source | Use | Authority |
|---|---|---|
| [PlanIt API](https://www.planit.org.uk/api/) | Bounded spatial discovery, references, decisions and official source links | Discovery/index only; never world geometry |
| Official council application pages | Application status, address, proposal and document list | Authoritative record metadata |
| Official council PDFs/images/native CAD | Layouts, elevations, materials, structures and landscape detail | World-authoritative only after automatic or reviewed eligibility gates |

PlanIt prevents the workflow from depending on one council search form, but an application is useful for reconstruction only when its documents resolve back to an allowlisted official council host. The generated world never treats PlanIt, a search result, or OSM as planning geometry.

## National and environmental sources

| Source | Use | Integration |
|---|---|---|
| [Planning Data](https://www.planning.data.gov.uk/docs) | Standardized planning/designation entities | Bounded adapter; supplemental/evidence only unless a reviewed planning derivative grants world authority |
| [Environment Agency DTM 1 m](https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc) | Bare-earth terrain elevation | Integrated (`ea-lidar`/GeoTIFF) |
| [Environment Agency DSM 1 m](https://environment.data.gov.uk/dataset/9ba4d5ac-d596-445a-9056-dae3ddec0178) | Roof, canopy and structure surface elevation | Integrated with matching DTM |
| [Defra Survey Data Download](https://environment.data.gov.uk/survey) | Time-stamped 25 cm/50 cm/1 m LiDAR discovery and downloads | Survey-index candidates ranked by finest resolution then newest date; downloaded archive GeoTIFFs can be supplied through the high-resolution GeoTIFF path |
| [Environment Agency vertical aerial photography](https://environment.data.gov.uk/dataset/dae203a8-ba24-4c54-bab0-866b9faadb58) | Appearance/canopy/path QA where reuse and resolution permit | GeoTIFF/orthophoto input |
| [National Trees Outside Woodland](https://www.data.gov.uk/dataset/171f673a-8491-4517-a56b-5f0fc7d65044/national-trees-outside-woodland-map) | Tree crowns/groups/small woodland | Integrated bounded adapter |
| [Tree Species Map England](https://environment.data.gov.uk/dataset/0c7a4e86-5fb2-4e13-867b-3d24c332f257) | Predicted species classification/confidence over mapped canopy | Integrated bounded GeoTIFF/COG window sampler; class legend required for species names |
| [OS OpenData](https://www.ordnancesurvey.co.uk/products/open-data) | Official open mapping and local detail | Local GeoJSON/source-config input; never silently supersedes planning |
| [OS NGD](https://docs.os.uk/osngd) | Building roof/storey attributes, structures, paths, water and field boundaries | Integrated optional bounded OGC adapter; repository API key and applicable OS terms required |
| [Living England](https://environment.data.gov.uk/dataset/042f14b2-3076-420d-b604-9657c0398fae) | Habitat/land-cover corroboration | Catalogued generic adapter/input |
| [EA Water Framework Directive data](https://environment.data.gov.uk/dataset/6436bedb-af10-4fd3-847c-66a91f63799c) | Water-body context | Catalogued generic adapter/input |
| [Historic England open data](https://historicengland.org.uk/listing/the-list/data-downloads/) | Listed structures/heritage constraints | Listed buildings, scheduled monuments, conservation areas and registered parks/gardens acquired through the bounded Planning Data adapter; generic Historic England layers also supported |
| [BGS OpenGeoscience](https://www.bgs.ac.uk/geological-data/opengeoscience/) | Ground/geology context | Catalogued generic adapter/input |
| [Copernicus Data Space APIs](https://documentation.dataspace.copernicus.eu/APIs.html) | Satellite and elevation discovery | Catalogued; requires dataset-specific adapter/credentials |
| [ESA WorldCover](https://esa-worldcover.org/en/data-access) | Regional land cover | Catalogued; coarse corroboration, not detailed park geometry |

## Alignment and discovery only

OpenStreetMap is obtained in a bounded query to establish coordinate registration and aid source discovery/QA. In planning-only mode it is removed before the reconstruction graph is built. Overture transportation is treated as OSM-derived and is removed too.

OS NGD is not OSM and may corroborate attributes or fill independently permitted water/vegetation detail. Its buildings, paths and structures still cannot override or bypass the planning-authority gate. The five built-in profiles enable the adapter, but it remains inactive unless `OS_NGD_API_KEY` is configured. Likewise, `TPMAP_TREE_SPECIES_MAP_URL` and `TPMAP_TREE_SPECIES_LEGEND_JSON` can be configured once at repository level so workflow users continue to select only the park.

Wikidata labels, Wikimedia Commons metadata, OpenAerialMap candidates and Microsoft ML building footprints are optional corroboration/gap-review sources. They do not acquire planning authority and they cannot survive the planning-only world filter unless converted into a separately reviewed, independently authoritative derivative under an explicit policy.

## Rights exclusions

The tool does not ingest Google Maps, Google Earth, Bing imagery, commercial basemaps, park promotional plans, photographs or manufacturer drawings without a compatible licence/permission. A URL visible to a browser is not an open-data licence.
