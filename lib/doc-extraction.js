'use babel'

/**
 * Class to extact doc-comment to use as suggestions' descriptions.
 *
 * Limitations:
 *
 * Limited require assigments support; to get doc from required module members:
 * - require result must be assigned to a variable with the same name as the module.
 * - the module must use a named object (same name as the module)
 *
 * To mitigate this limitation, this class uses unqualified identifiers as a fallback.
 *
 */
export default class DocExtractor {

  constructor() {
    this.nodes = []
  }

  /**
   * To call when luaparse creates a node.
   */
  onCreateNode(node) {
    this.nodes.push( node )
  }

  /**
   * Returns identifier for a node.
   *
   * @arg {Object} node - The node.
   * @arg {bool} qualified - If true, returns the qualified identifier if possible.
   *
   * @returns {string} - The identifier, or an empty string if given node doesn't have id.
   */
  getIdentifier( node, qualified ) {
      if( ! node ) return ''
      switch( node.type ) {

        case 'AssignmentStatement':
          // HAX: only look first var
          return this.getIdentifier( node.variables[0], qualified )

        case 'FunctionDeclaration':
          return this.getIdentifier( node.identifier, qualified )

        case 'MemberExpression':
          return qualified
            ? this.getIdentifier(node.base) +'.'+ this.getIdentifier(node.identifier)
            : this.getIdentifier(node.identifier)

        case 'Identifier':
          return node.name
      }
      return ''
  }

  /**
   * Returns the doc-comment for given identifier.
   *
   * @arg {string} id - The (qualified or not) identifier.
   *
   * @returns {string}
   */
  getDescription( id ) {
    if( ! DocExtractor.descriptionsByQid ) return undefined
    return DocExtractor.descriptionsByQid[id]
  }

  /**
   * Sets field/function description.
   *
   * @arg {string} id - The (qualified or not) identifier.
   * @arg {string} descr - The description.
   */
  setDescription( id, descr ) {
    if( ! DocExtractor.descriptionsByQid ) DocExtractor.descriptionsByQid = {}
    DocExtractor.descriptionsByQid[id] = descr
  }

  addDescriptionsToQueryType( queryType, queryBaseName ) {
    if( ! queryType ) return;
    let fields = queryType.fields
    for( let fieldName in fields ) {
      if( ! fields.hasOwnProperty(fieldName) ) continue;
      let field = fields[fieldName]
      let qid = queryBaseName + '.' + fieldName
      field.description = this.getDescription(qid)
      // fallback to unqualified name
      if( ! field.description ) {
        field.description = this.getDescription(fieldName)
      }
    }
  }

  addDescriptionsToResults( results ) {
    for( let result of results ) {
      result.typeDef.description = this.getDescription( result.key )
    }
  }

  /**
   *
   */
  processNodes() {
    let nodes = this.nodes.sort( function(a, b) {
      return a.range[0] - b.range[0]
    })
    let lastNodeType = ''
    let i = 0
    for( let node of nodes ) {
      switch( node.type ) {
        case 'Comment':
          if( lastNodeType != 'Comment' ) DocExtractor.lastComment = ''
          DocExtractor.lastComment += node.raw.slice(2).trim() + '\n'
          break

        case 'FunctionDeclaration':
        case 'AssignmentStatement':
          if( DocExtractor.lastComment === '' ) break
          let id = this.getIdentifier(node, false)
          let qid = this.getIdentifier(node, true)
          if( ! this.getDescription(qid) ) {
            if(qid) this.setDescription( qid, DocExtractor.lastComment )
            if(id) this.setDescription( id, DocExtractor.lastComment )
          }
          DocExtractor.lastComment = ''
          break

        case 'LocalStatement':
          DocExtractor.lastComment = ''
          break
      }
      lastNodeType = node.type
      i++
    }
  }

}
