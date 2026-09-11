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
	
	    static createFrom(source: any = {}) {
	        return new QueryResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.results = this.convertValues(source["results"], Result);
	        this.error = source["error"];
	        this.durationMs = source["durationMs"];
	        this.cancelled = source["cancelled"];
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

}

