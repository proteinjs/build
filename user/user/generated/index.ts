/** Load Dependency Source Graphs */

import '@brentbahry/reflection';
import '@proteinjs/db';
import 'moment';


/** Generate Source Graph */

const sourceGraph = "{\"options\":{\"directed\":true,\"multigraph\":false,\"compound\":false},\"nodes\":[{\"v\":\"@proteinjs/user/guestUser\",\"value\":{\"packageName\":\"@proteinjs/user\",\"name\":\"guestUser\",\"filePath\":\"/Users/brentbahry/repos/components/user/user/src/guestUser.ts\",\"qualifiedName\":\"@proteinjs/user/guestUser\",\"type\":{\"packageName\":\"@proteinjs/user\",\"name\":\"User\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/user/User\",\"typeParameters\":[],\"directParents\":[{\"packageName\":\"@proteinjs/user\",\"name\":\"User\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/user/User\",\"typeParameters\":[],\"directParents\":null}]},\"isExported\":true,\"isConst\":true,\"sourceType\":0}},{\"v\":\"@proteinjs/user/User\",\"value\":{\"packageName\":\"@proteinjs/user\",\"name\":\"User\",\"filePath\":\"/Users/brentbahry/repos/components/user/user/src/tables/UserTable.ts\",\"qualifiedName\":\"@proteinjs/user/User\",\"typeParameters\":[],\"directParents\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"Record\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/Record\",\"typeParameters\":[],\"directParents\":null},{\"packageName\":\"@proteinjs/user\",\"name\":\"{\\n    name: string,\\n    email: string,\\n    password: string,\\n    emailVerified: boolean,\\n    roles: string\\n}\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/user/{\\n    name: string,\\n    email: string,\\n    password: string,\\n    emailVerified: boolean,\\n    roles: string\\n}\",\"typeParameters\":[],\"directParents\":null}],\"sourceType\":1}},{\"v\":\"@proteinjs/user/Session\",\"value\":{\"packageName\":\"@proteinjs/user\",\"name\":\"Session\",\"filePath\":\"/Users/brentbahry/repos/components/user/user/src/tables/SessionTable.ts\",\"qualifiedName\":\"@proteinjs/user/Session\",\"typeParameters\":[],\"directParents\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"Record\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/Record\",\"typeParameters\":[],\"directParents\":null},{\"packageName\":\"@proteinjs/user\",\"name\":\"{\\n    sessionId: string,\\n    session: string,\\n    expires: Date,\\n    userEmail: string\\n}\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/user/{\\n    sessionId: string,\\n    session: string,\\n    expires: Date,\\n    userEmail: string\\n}\",\"typeParameters\":[],\"directParents\":null}],\"sourceType\":1}},{\"v\":\"@proteinjs/db/Record\"},{\"v\":\"@proteinjs/user/SessionTable\",\"value\":{\"packageName\":\"@proteinjs/user\",\"name\":\"SessionTable\",\"filePath\":\"/Users/brentbahry/repos/components/user/user/src/tables/SessionTable.ts\",\"qualifiedName\":\"@proteinjs/user/SessionTable\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"name\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"columns\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[],\"typeParameters\":[],\"directParentInterfaces\":[],\"directParentClasses\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"Table\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/Table\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[],\"methods\":[],\"typeParameters\":[\"@proteinjs/user/Session\"],\"directParentInterfaces\":[],\"directParentClasses\":[]}],\"sourceType\":2}},{\"v\":\"@proteinjs/db/Table\"},{\"v\":\"@proteinjs/user/UserTable\",\"value\":{\"packageName\":\"@proteinjs/user\",\"name\":\"UserTable\",\"filePath\":\"/Users/brentbahry/repos/components/user/user/src/tables/UserTable.ts\",\"qualifiedName\":\"@proteinjs/user/UserTable\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[{\"name\":\"name\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"},{\"name\":\"columns\",\"type\":null,\"isOptional\":false,\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\"}],\"methods\":[],\"typeParameters\":[],\"directParentInterfaces\":[],\"directParentClasses\":[{\"packageName\":\"@proteinjs/db\",\"name\":\"Table\",\"filePath\":null,\"qualifiedName\":\"@proteinjs/db/Table\",\"isAbstract\":false,\"isStatic\":false,\"visibility\":\"public\",\"properties\":[],\"methods\":[],\"typeParameters\":[\"@proteinjs/user/User\"],\"directParentInterfaces\":[],\"directParentClasses\":[]}],\"sourceType\":2}}],\"edges\":[{\"v\":\"@proteinjs/user/guestUser\",\"w\":\"@proteinjs/user/User\",\"value\":\"has type\"},{\"v\":\"@proteinjs/user/Session\",\"w\":\"@proteinjs/db/Record\",\"value\":\"extends type\"},{\"v\":\"@proteinjs/user/SessionTable\",\"w\":\"@proteinjs/db/Table\",\"value\":\"extends class\"},{\"v\":\"@proteinjs/user/User\",\"w\":\"@proteinjs/db/Record\",\"value\":\"extends type\"},{\"v\":\"@proteinjs/user/UserTable\",\"w\":\"@proteinjs/db/Table\",\"value\":\"extends class\"}]}";


/** Generate Source Links */

import { guestUser } from '../src/guestUser';
import { SessionTable } from '../src/tables/SessionTable';
import { UserTable } from '../src/tables/UserTable';

const sourceLinks = {
	'@proteinjs/user/guestUser': guestUser,
	'@proteinjs/user/SessionTable': SessionTable,
	'@proteinjs/user/UserTable': UserTable,
};


/** Load Source Graph and Links */

import { SourceRepository } from '@brentbahry/reflection';
SourceRepository.merge(sourceGraph, sourceLinks);


export * from '../index';