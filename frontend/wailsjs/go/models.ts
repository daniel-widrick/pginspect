export namespace config {
	
	export class Profile {
	    id: string;
	    name: string;
	    host: string;
	    port: number;
	    database: string;
	    user: string;
	    sslMode: string;
	    savePassword: boolean;
	    color: string;
	
	    static createFrom(source: any = {}) {
	        return new Profile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.database = source["database"];
	        this.user = source["user"];
	        this.sslMode = source["sslMode"];
	        this.savePassword = source["savePassword"];
	        this.color = source["color"];
	    }
	}

}

export namespace db {
	
	export class Column {
	    name: string;
	    typeOid: number;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new Column(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.typeOid = source["typeOid"];
	        this.type = source["type"];
	    }
	}
	export class ColumnInfo {
	    name: string;
	    type: string;
	    notNull: boolean;
	    default: string;
	    primaryKey: boolean;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new ColumnInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.notNull = source["notNull"];
	        this.default = source["default"];
	        this.primaryKey = source["primaryKey"];
	        this.comment = source["comment"];
	    }
	}
	export class ConstraintInfo {
	    name: string;
	    type: string;
	    definition: string;
	
	    static createFrom(source: any = {}) {
	        return new ConstraintInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.definition = source["definition"];
	    }
	}
	export class ExplainResponse {
	    plan: string;
	    analyze: boolean;
	    generic: boolean;
	    error: string;
	    durationMs: number;
	    cancelled: boolean;
	    timedOut: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ExplainResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.plan = source["plan"];
	        this.analyze = source["analyze"];
	        this.generic = source["generic"];
	        this.error = source["error"];
	        this.durationMs = source["durationMs"];
	        this.cancelled = source["cancelled"];
	        this.timedOut = source["timedOut"];
	    }
	}
	export class IndexInfo {
	    name: string;
	    definition: string;
	
	    static createFrom(source: any = {}) {
	        return new IndexInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.definition = source["definition"];
	    }
	}
	export class Info {
	    id: string;
	    serverVersion: string;
	    database: string;
	    user: string;
	
	    static createFrom(source: any = {}) {
	        return new Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.serverVersion = source["serverVersion"];
	        this.database = source["database"];
	        this.user = source["user"];
	    }
	}
	export class QueryExample {
	    queryId: string;
	    query: string;
	    user: string;
	    database: string;
	    // Go type: time
	    firstSeen: any;
	    // Go type: time
	    lastSeen: any;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new QueryExample(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.queryId = source["queryId"];
	        this.query = source["query"];
	        this.user = source["user"];
	        this.database = source["database"];
	        this.firstSeen = this.convertValues(source["firstSeen"], null);
	        this.lastSeen = this.convertValues(source["lastSeen"], null);
	        this.count = source["count"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Result {
	    columns: Column[];
	    rows: string[][];
	    rowCount: number;
	    truncated: boolean;
	    command: string;
	    rowsAffected: number;
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = this.convertValues(source["columns"], Column);
	        this.rows = source["rows"];
	        this.rowCount = source["rowCount"];
	        this.truncated = source["truncated"];
	        this.command = source["command"];
	        this.rowsAffected = source["rowsAffected"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class QueryResponse {
	    results: Result[];
	    error: string;
	    durationMs: number;
	    cancelled: boolean;
	    timedOut: boolean;
	    limitStopped: boolean;
	
	    static createFrom(source: any = {}) {
	        return new QueryResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.results = this.convertValues(source["results"], Result);
	        this.error = source["error"];
	        this.durationMs = source["durationMs"];
	        this.cancelled = source["cancelled"];
	        this.timedOut = source["timedOut"];
	        this.limitStopped = source["limitStopped"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Relation {
	    schema: string;
	    name: string;
	    kind: string;
	    comment: string;
	    rowsEst: number;
	
	    static createFrom(source: any = {}) {
	        return new Relation(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.comment = source["comment"];
	        this.rowsEst = source["rowsEst"];
	    }
	}
	export class RelationInfo {
	    relation: Relation;
	    columns: ColumnInfo[];
	    indexes: IndexInfo[];
	    constraints: ConstraintInfo[];
	    ddl: string;
	
	    static createFrom(source: any = {}) {
	        return new RelationInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.relation = this.convertValues(source["relation"], Relation);
	        this.columns = this.convertValues(source["columns"], ColumnInfo);
	        this.indexes = this.convertValues(source["indexes"], IndexInfo);
	        this.constraints = this.convertValues(source["constraints"], ConstraintInfo);
	        this.ddl = source["ddl"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Routine {
	    schema: string;
	    name: string;
	    arguments: string;
	    returns: string;
	    kind: string;
	    oid: number;
	
	    static createFrom(source: any = {}) {
	        return new Routine(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.schema = source["schema"];
	        this.name = source["name"];
	        this.arguments = source["arguments"];
	        this.returns = source["returns"];
	        this.kind = source["kind"];
	        this.oid = source["oid"];
	    }
	}
	export class SamplingStatus {
	    supported: boolean;
	    running: boolean;
	    message: string;
	    samples: number;
	    maxQueryLength: number;
	    counts: Record<string, number>;
	
	    static createFrom(source: any = {}) {
	        return new SamplingStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.supported = source["supported"];
	        this.running = source["running"];
	        this.message = source["message"];
	        this.samples = source["samples"];
	        this.maxQueryLength = source["maxQueryLength"];
	        this.counts = source["counts"];
	    }
	}
	export class Schema {
	    name: string;
	    comment: string;
	
	    static createFrom(source: any = {}) {
	        return new Schema(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.comment = source["comment"];
	    }
	}
	export class SlowLogEntry {
	    // Go type: time
	    time: any;
	    user: string;
	    database: string;
	    pid: number;
	    durationMs: number;
	    command: string;
	    query: string;
	    params?: Record<string, string>;
	    queryId: string;
	    app: string;
	    file: string;
	
	    static createFrom(source: any = {}) {
	        return new SlowLogEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.time = this.convertValues(source["time"], null);
	        this.user = source["user"];
	        this.database = source["database"];
	        this.pid = source["pid"];
	        this.durationMs = source["durationMs"];
	        this.command = source["command"];
	        this.query = source["query"];
	        this.params = source["params"];
	        this.queryId = source["queryId"];
	        this.app = source["app"];
	        this.file = source["file"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SlowLogStatus {
	    readable: boolean;
	    logging: boolean;
	    message: string;
	    loggingCollector: string;
	    logDestination: string;
	    logMinDurationStatement: string;
	    logDirectory: string;
	    logLinePrefix: string;
	    logParameterMaxLength: string;
	    format: string;
	    files: number;
	
	    static createFrom(source: any = {}) {
	        return new SlowLogStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.readable = source["readable"];
	        this.logging = source["logging"];
	        this.message = source["message"];
	        this.loggingCollector = source["loggingCollector"];
	        this.logDestination = source["logDestination"];
	        this.logMinDurationStatement = source["logMinDurationStatement"];
	        this.logDirectory = source["logDirectory"];
	        this.logLinePrefix = source["logLinePrefix"];
	        this.logParameterMaxLength = source["logParameterMaxLength"];
	        this.format = source["format"];
	        this.files = source["files"];
	    }
	}
	export class SlowLogResult {
	    entries: SlowLogEntry[];
	    bytesRead: number;
	    complete: boolean;
	    status: SlowLogStatus;
	
	    static createFrom(source: any = {}) {
	        return new SlowLogResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.entries = this.convertValues(source["entries"], SlowLogEntry);
	        this.bytesRead = source["bytesRead"];
	        this.complete = source["complete"];
	        this.status = this.convertValues(source["status"], SlowLogStatus);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class StatStatement {
	    queryId: string;
	    query: string;
	    user: string;
	    database: string;
	    topLevel: boolean;
	    calls: number;
	    totalMs: number;
	    meanMs: number;
	    minMs: number;
	    maxMs: number;
	    stddevMs: number;
	    planMs: number;
	    rows: number;
	    sharedHit: number;
	    sharedRead: number;
	    sharedDirtied: number;
	    sharedWritten: number;
	    tempRead: number;
	    tempWritten: number;
	    ioReadMs: number;
	    ioWriteMs: number;
	    walBytes: number;
	
	    static createFrom(source: any = {}) {
	        return new StatStatement(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.queryId = source["queryId"];
	        this.query = source["query"];
	        this.user = source["user"];
	        this.database = source["database"];
	        this.topLevel = source["topLevel"];
	        this.calls = source["calls"];
	        this.totalMs = source["totalMs"];
	        this.meanMs = source["meanMs"];
	        this.minMs = source["minMs"];
	        this.maxMs = source["maxMs"];
	        this.stddevMs = source["stddevMs"];
	        this.planMs = source["planMs"];
	        this.rows = source["rows"];
	        this.sharedHit = source["sharedHit"];
	        this.sharedRead = source["sharedRead"];
	        this.sharedDirtied = source["sharedDirtied"];
	        this.sharedWritten = source["sharedWritten"];
	        this.tempRead = source["tempRead"];
	        this.tempWritten = source["tempWritten"];
	        this.ioReadMs = source["ioReadMs"];
	        this.ioWriteMs = source["ioWriteMs"];
	        this.walBytes = source["walBytes"];
	    }
	}
	export class StatsResponse {
	    available: boolean;
	    installable: boolean;
	    preloaded: boolean;
	    message: string;
	    statsReset: string;
	    statements: StatStatement[];
	    totalMs: number;
	    totalCalls: number;
	
	    static createFrom(source: any = {}) {
	        return new StatsResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.installable = source["installable"];
	        this.preloaded = source["preloaded"];
	        this.message = source["message"];
	        this.statsReset = source["statsReset"];
	        this.statements = this.convertValues(source["statements"], StatStatement);
	        this.totalMs = source["totalMs"];
	        this.totalCalls = source["totalCalls"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace diagram {
	
	export class Span {
	    Text: string;
	    Style: string;
	
	    static createFrom(source: any = {}) {
	        return new Span(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.Text = source["Text"];
	        this.Style = source["Style"];
	    }
	}

}

export namespace spec {
	
	export class Edge {
	    from: string;
	    to: string;
	    label?: string;
	    kind?: string;
	    weight?: number;
	    arrow?: string;
	
	    static createFrom(source: any = {}) {
	        return new Edge(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.from = source["from"];
	        this.to = source["to"];
	        this.label = source["label"];
	        this.kind = source["kind"];
	        this.weight = source["weight"];
	        this.arrow = source["arrow"];
	    }
	}
	export class Group {
	    id: string;
	    label?: string;
	    kind?: string;
	
	    static createFrom(source: any = {}) {
	        return new Group(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.kind = source["kind"];
	    }
	}
	export class Node {
	    id: string;
	    kind?: string;
	    bar?: number;
	    maxWidth?: number;
	    overflow?: string;
	    collapsed?: boolean;
	    group?: string;
	    lines: diagram.Span[][];
	
	    static createFrom(source: any = {}) {
	        return new Node(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.bar = source["bar"];
	        this.maxWidth = source["maxWidth"];
	        this.overflow = source["overflow"];
	        this.collapsed = source["collapsed"];
	        this.group = source["group"];
	        this.lines = this.convertValues(source["lines"], diagram.Span);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Graph {
	    direction?: string;
	    routing?: string;
	    rankSep?: number;
	    nodeSep?: number;
	    margin?: number;
	    nodes: Node[];
	    edges: Edge[];
	    groups?: Group[];
	
	    static createFrom(source: any = {}) {
	        return new Graph(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.direction = source["direction"];
	        this.routing = source["routing"];
	        this.rankSep = source["rankSep"];
	        this.nodeSep = source["nodeSep"];
	        this.margin = source["margin"];
	        this.nodes = this.convertValues(source["nodes"], Node);
	        this.edges = this.convertValues(source["edges"], Edge);
	        this.groups = this.convertValues(source["groups"], Group);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	

}

