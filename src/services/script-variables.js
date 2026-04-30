export function applyScriptVariables(content, lead) {
    return content
        .replace(/{{nome}}/gi,    lead?.name?.split(' ')[0] || 'você')
        .replace(/{{empresa}}/gi, lead?.company_name || 'sua empresa')
        .replace(/{{data}}/gi,    new Date().toLocaleDateString('pt-BR'))
        .replace(/{{dominio}}/gi, lead?.metadata?.domain || 'seu site');
}
