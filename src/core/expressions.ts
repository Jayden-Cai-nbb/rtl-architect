// Restricted integer arithmetic for architecture parameters. Never executes JavaScript/HDL.
function expressionTokens(expression:string):string[]{
  if (expression.length > 2048) throw new Error('参数表达式过长');
  const pattern = /\s*(\$clog2|[A-Za-z_][A-Za-z0-9_]*|\d+'[hHbBoOdD][0-9a-fA-F_]+|0[xX][0-9a-fA-F]+|\d+|<<|>>|[()+\-*/%&|^~,])/gy;
  const tokens: string[]=[]; let position=0;
  while(position<expression.trimEnd().length){pattern.lastIndex=position;const match=pattern.exec(expression);if(!match)throw new Error(`不支持的参数表达式位置 ${position}`);tokens.push(match[1]);position=pattern.lastIndex;}
  return tokens;
}
export function expressionReferences(expression:string):string[]{
  return [...new Set(expressionTokens(expression).filter(token=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)))];
}
export function integerExpression(expression: string, lookup: (name: string) => number): number {
  const tokens=expressionTokens(expression);
  let cursor=0,depth=0;
  const checked=(value:bigint)=>{if(value.toString(2).length>128)throw new Error('参数运算超过128位安全求值范围');return value};
  const priority:Record<string,number>={'|':1,'^':2,'&':3,'<<':4,'>>':4,'+':5,'-':5,'*':6,'/':6,'%':6};
  function atom():bigint {
    if(++depth>64)throw new Error('参数表达式嵌套过深');
    const token=tokens[cursor++];let value:bigint;
    if(token==='('){value=parse(0);if(tokens[cursor++]!==')')throw new Error('缺少右括号');}
    else if(['+','-','~'].includes(token)){const x=atom();value=token==='-'?-x:token==='~'?~x:x;}
    else if(token==='$clog2'){if(tokens[cursor++]!=='(')throw new Error('clog2 缺少括号');const x=parse(0);if(tokens[cursor++]!==')'||x<0n)throw new Error('clog2 参数无效');value=x<=1n?0n:BigInt((x-1n).toString(2).length);}
    else if(token&&/^\d+'/.test(token)){const [width,raw]=token.split("'");const base=raw[0].toLowerCase(),digits=raw.slice(1).replaceAll('_','');if(Number(width)>128||Number(width)<1)throw new Error('参数字面量仅支持1..128位');value=BigInt((base==='h'?'0x':base==='b'?'0b':base==='o'?'0o':'')+digits);if(value>=(1n<<BigInt(width)))throw new Error('参数字面量溢出，需显式处理截断');}
    else if(token&&/^(\d|0x)/i.test(token))value=BigInt(token);
    else if(token&&/^[A-Za-z_]/.test(token)){const x=lookup(token);if(!Number.isSafeInteger(x))throw new Error(`参数 ${token} 不是安全整数`);value=BigInt(x);}
    else throw new Error('参数表达式缺少操作数');
    depth--;return checked(value);
  }
  function parse(min:number):bigint {
    let left=atom();
    while((priority[tokens[cursor]]??-1)>=min){const op=tokens[cursor++],right=parse(priority[op]+1);
      if((op==='/'||op==='%')&&right===0n)throw new Error('参数除零');
      if((op==='<<'||op==='>>')&&(right<0n||right>127n))throw new Error('移位量须为0..127');
      left=checked(op==='+'?left+right:op==='-'?left-right:op==='*'?left*right:op==='/'?left/right:op==='%'?left%right:op==='<<'?left<<right:op==='>>'?left>>right:op==='&'?left&right:op==='|'?left|right:left^right);
    }return left;
  }
  const value=parse(0);if(cursor!==tokens.length)throw new Error('参数表达式有多余内容');const result=Number(value);if(!Number.isSafeInteger(result))throw new Error('参数结果超出 JSON 安全整数');return result;
}
