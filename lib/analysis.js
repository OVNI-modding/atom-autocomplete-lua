'use babel'

/*
 * The type analysis sweep
 */

import {
  tableNew, unknownNew,
  tableSet, tableGet, tableSetMetatable, tableGetMetatable,
  tableSearch,
  tableInvalidateDiffs, tableFreeze, tableDiffShallow, tableDiff, tableApplyDiff
} from './typedefs'
import { nodeGetType, nodeGetReturnTypes } from './resolve'
import extractTypes from './extraction'
import formatResults from './format'
import luaparse from 'dapetcu21-luaparse'
import ModuleCache from './module-cache'
import config from './config'

export default class Analysis {
  constructor (options, query) {
    this.query = query
    this.queryBase = null
    this.queryType = null
    this.chunk = null
    this.nodes = []
    if (query && query.dot !== ':' && query.dot !== '.') {
      query.dot = null
    }

    const globalScope = options.global
    tableInvalidateDiffs()
    if (tableGet(globalScope, '_G') !== globalScope) {
      tableSet(globalScope, '_G', globalScope)
    }
    tableFreeze(globalScope)

    this.currentScope = globalScope
    this.globalScope = globalScope
    this.options = options
    options.moduleCache = options.moduleCache || new ModuleCache(options)

    this.iteration = []
    this.requires = new Set()
    this.requireCache = {}

    const luaVersion = options.luaVersion || config.luaVersion || '5.2'
    luaparse.parse({
      wait: true,
      comments: true,
      ranges: true,
      scope: true,
      luaVersion: luaVersion === 'luajit-2.0' ? '5.1' : luaVersion,
      onCreateNode: this._onCreateNode,
      onCreateScope: this._onCreateScope,
      onDestroyScope: this._onDestroyScope,
      onScopeIdentifierName: this._onScopeIdentifierName
    })
  }


  _onCreateNode = (node) => {
    this.iteration.push(node)
    node.scope = this.currentScope
    node.globalScope = this.globalScope
    node.options = this.options

    this.nodes.push( node )

    if (node.type === 'Chunk') {
      this.chunk = node
    }

    if (
      (node.type === 'CallExpression' || node.type === 'StringCallExpression') &&
      node.base.type === 'Identifier' &&
      node.base.name === 'require'
    ) {
      const argument = node.argument || (node.arguments && node.arguments[0])
      if (argument && argument.type === 'StringLiteral') {
        this.requires.add(argument.value)
        node.requireValue = argument.value
        node.requireCache = this.requireCache
      }
    }

    if (
      this.query &&
      node.type === 'MemberExpression' &&
      node.identifier.name.indexOf('__prefix_placeholder__') !== -1
    ) {
      if (this.query.dot) {
        this.queryBase = node.base
      } else {
        this.queryType = node.scope
      }
      node.isPlaceholder = true
      node.identifier.isPlaceholder = true
      if (
        node.base &&
        node.base.type === 'Identifier' &&
        node.base.name.indexOf('__prefix_placeholder__') !== -1
      ) {
        node.base.isPlaceholder = true
      }
    }

    __LOG__ && console.log('onCreateNode', node)
  };

  _onCreateScope = () => {
    __LOG__ && console.log('onCreateScope')
    const oldScope = this.currentScope
    const metatable = tableNew()
    tableSet(metatable, '__index', oldScope)
    this.currentScope = tableNew()
    tableSetMetatable(this.currentScope, metatable)
  };

  _onDestroyScope = () => {
    __LOG__ && console.log('onDestroyScope')
    const parentScope = tableGet(tableGetMetatable(this.currentScope), '__index')
    this.currentScope = parentScope
  };

  _onScopeIdentifierName = (newName, data) => {
    __LOG__ && console.log('onScopeIdentifierName', newName, data)
    if (newName.indexOf('__prefix_placeholder__') !== -1) { return }

    if (data && data.parameterOf) {
      const func = nodeGetType(data.parameterOf)
      if (func && func.type === 'function' && func.argTypes) {
        const argType = func.argTypes[data.parameterIndex]
        if (argType) {
          tableSet(this.currentScope, newName, argType)
          return
        }
      }
    }

    tableSet(this.currentScope, newName, unknownNew())
  };

  write (string) {
    luaparse.write(string)
  }

  end (string) {
    luaparse.end(string)
  }

  _evaluate = async (syncAction) => {
    if (this.requires.size && config.completeModules) {
      const mainDiff = tableDiffShallow(this.globalScope)
      await Promise.all([...this.requires].map(async moduleName => {
        const module = await this.options.moduleCache.get(moduleName, this._analyseModule)
        this.requireCache[moduleName] = module
      }))
      tableInvalidateDiffs()
      tableApplyDiff(mainDiff)
    }
    this.iteration.forEach(extractTypes)

    // Due to the stateful nature of tableDiffCount, we need to sample data
    // quickly before we return to the run loop and let another Analysis take
    // place, so .then()-ing promises is out of the question
    return syncAction()
  }

  _analyseModule = async (moduleData) => {
    const analysis = new Analysis(this.options)
    try {
      analysis.end(moduleData)
      analysis._processNodes()
    } catch (ex) {
      __LOG__ && console.error(ex)
    }
    return await analysis.returnModule()
  };

  returnModule = async () => {
    return await this._evaluate(() => {
      const returnTypes = this.chunk ? nodeGetReturnTypes(this.chunk.body) : []
      const globalDiff = tableDiff(this.globalScope)
      return { returnTypes, globalDiff }
    })
  }


  _getQualifiedIdentifier( nodes, i ) {
    let node = nodes[i]
    switch( node.type ) {
      case 'FunctionDeclaration':
        if( ! node.identifier ) {
          // 'a.b.c = function()' form
          // backtrack to get qualified identifier
          for( let j=i-1; j>=0; j-- ) {
            let backNode = nodes[j]
            if( backNode.type === 'AssignmentStatement' ) {
              let variable = backNode.variables[0]
              if( ! variable.base) return variable.name
              return variable.base.name + '.' + variable.identifier.name
            }
          }
          return ''
        }
        if( ! node.identifier.base) return node.identifier.name
        return node.identifier.base.name + '.' + node.identifier.identifier.name
      default:
        return ''
    }
  }

  _getDescription( qid ) {
    if( ! Analysis.descriptionsByQid ) return undefined
    return Analysis.descriptionsByQid[qid]
  }

  _setDescription( qid, descr ) {
    if( ! Analysis.descriptionsByQid ) Analysis.descriptionsByQid = {}
    Analysis.descriptionsByQid[qid] = descr
  }

  _addDescriptionsToQueryType( queryType ) {
    if( ! queryType ) return;
    let fields = queryType.fields
    for( let fieldName in fields ) {
      if( ! fields.hasOwnProperty(fieldName) ) continue;
      let field = fields[fieldName]
      let qid = this.queryBase.name + '.' + fieldName
      field.description = this._getDescription(qid)
    }
  }

  _addDescriptionsToResults( results ) {
    for( let result of results ) {
      result.typeDef.description = this._getDescription( result.key )
    }
  }

  _processNodes() {
    let nodes = this.nodes.sort( function(a, b) {
      return a.range[0] - b.range[0]
    });
    let lastNodeType = ''
    let i = 0
    for( let node of nodes ) {
      switch( node.type ) {
        case 'Comment':
          if( lastNodeType != 'Comment' ) Analysis.lastComment = ''
          Analysis.lastComment += node.raw.slice(2).trim() + '\n'
          break

        case 'FunctionDeclaration':
          if( Analysis.lastComment === '' ) break
          let qid = this._getQualifiedIdentifier(nodes, i)
          this._setDescription( qid, Analysis.lastComment )
          Analysis.lastComment = ''
          break
      }
      lastNodeType = node.type
      i++
    }
  }


  solveQuery = async () => {
    return await this._evaluate(() => {

      this._processNodes()

      let queryType = this.queryType
      if (this.queryBase) {
        queryType = nodeGetType(this.queryBase)
        this._addDescriptionsToQueryType(queryType)
      }

      if (!queryType) { return [] }

      let results = tableSearch(queryType, this.query.prefix)
      const trimSelf = this.query.dot === ':'
      if (trimSelf) {
        results = results.filter(x => x.typeDef && x.typeDef.type === 'function')
      }
      results.sort((a, b) => a.key.localeCompare(b.key))

      if( ! this.queryBase ) {
        this._addDescriptionsToResults( results )
      }

      return formatResults(results, trimSelf)
    })
  }
}
