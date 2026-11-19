"""Source-scoped partial model for the four selected axis_fifo configurations."""


def endpoint(name, local=False, bits=None):
    result = dict(moduleId='top', interfaceId=name)
    if local:
        result['local'] = True
    if bits is not None:
        result['slice'] = dict(lsb=bits[0], msb=bits[1])
    return result


def signal(name, local=False, bits=None):
    return dict(kind='endpoint', endpoint=endpoint(name, local, bits))


def operator(name, *operands):
    return dict(kind='operator', operator=name, operands=operands)


def literal(width, value):
    return dict(kind='constant', width=width, value=str(value))


def reads(value):
    if value['kind'] == 'endpoint':
        return [value['endpoint']]
    return [e for child in value.get('operands', value.get('parts', [])) for e in reads(child)]


PIN = dict(pipe_word0='m_axis_pipe_reg[0]', pipe_word1='m_axis_pipe_reg[1]', pause_q='pause.pause_reg')


def source_model(raw, config, rtl_hash, tb_hash):
    model = raw
    module = model['modules'][0]
    state, links = model['localSignals'], model['connections']
    provenance = model['provenance']
    assert module['id'] == 'top'
    assert provenance['origin'] == 'as_built' and provenance['fidelity'] == 'partial'
    frame = bool(config['FRAME_FIFO'])
    keep = config['KEEP_WIDTH']
    addr = 10
    pw = addr + 1
    fields = dict(tdata=config['DATA_WIDTH'], tkeep=keep, tlast=1, tid=8, tdest=8, tuser=1)
    dw = sum(fields.values())
    model['clocks'] = [dict(id='clk', edge='rising')]
    model['resets'] = [dict(id='rst', clock='clk', synchronous=True, activeLevel='high')]
    module.update(clock='clk', reset='rst', timing='mixed')
    confidence = '普通 FIFO 逐 beat 可读' if not frame else '仅有效帧末端推进提交指针'
    module['contract'].update(responsibility=f'{confidence}。地址化 RAM 保存 beat，读后经两级有效管线到出口。',
        latencyMinCycles=3, latencyCondition='空载、下游持续就绪，从普通 beat 接受或首帧提交到第一笔出口消费至少 3 沿。',
        backpressure='RAM 满时普通帧等待读指针释放空间。启用超长丢弃时，当前超长帧可继续握手到 last。',
        resetBehavior='同步清零三指针和管线 valid。RAM 内容未清零，旧事务不能再到达出口。',
        invariants=['出口保留启用的 sideband。状态深度仅计 RAM，采用前一沿指针差并以数据字报告。'],
        verificationPlan=['原版 pytest 与独立定向端口队列分别核对。'],
        openQuestions=['RAM 数组和读写关系仍是来源缺口。暂停功能仅由原版测试覆盖。'])
    groups = [('ingress', '入口 beat', 'data'), ('egress', '出口 beat', 'data'),
              ('flow', '握手与状态', 'control'), ('clocking', '时钟复位', 'clock_reset')]
    module['interfaceGroups'] = [dict(id=i, label=l, category=c, description=l) for i,l,c in groups]
    for port in module['interfaces']:
        name = port['id']
        port['group'] = 'clocking' if name in ('clk', 'rst') else 'ingress' if name[7:] in fields and name.startswith('s_axis_') else \
            'egress' if name[7:] in fields and name.startswith('m_axis_') else 'flow'
    model['specification'] = dict(summary='固定配置的 AXI Stream FIFO 现状还原，包含地址、提交边界与两级输出管线。',
        requirements=[dict(id='frame_visibility', moduleIds=['top'], text='帧模式只允许完整好帧成为出口可见数据。',
                           acceptance='首 beat 后停送，检查 last 完成前出口无 valid。坏帧与超长帧回滚后，好帧仍能按序到达。')] if frame else [],
        decisions=[], openQuestions=['存储数组和读访问暂以源码与波形证据交付。'])

    def evidence(id_, first, last, ids):
        provenance['evidence'].append(dict(id=id_, file='rtl/axis_fifo.v', fileHash=rtl_hash, line=first, endLine=last,
            sourceKind='code', targets=[dict(kind='local', moduleId='top', itemId=s) for s in ids]))

    evidence('address_logic', 189, 219, ['wr_ptr_reg', 'wr_ptr_commit_reg', 'rd_ptr_reg'])
    evidence('write_logic', 261, 362, ['wr_ptr_reg', 'wr_ptr_commit_reg', 'drop_frame_reg'])
    evidence('depth_logic', 366, 370, ['depth_reg', 'depth_commit_reg'])
    evidence('read_logic', 372, 398, ['rd_ptr_reg', 'pipe_word0', 'pipe_word1', 'm_axis_tvalid_pipe_reg'])
    evidence('pause_logic', 501, 544, ['pause_q'])
    provenance['evidence'].append(dict(id='test_inputs', file='tb/axis_fifo/test_axis_fifo.py', fileHash=tb_hash,
        line=450, endLine=507, sourceKind='test', targets=[dict(kind='module', moduleId='top')]))
    provenance['scope'] = '实际端口、可核对的地址和控制规则、部分管线与外部连接。RAM 单元和数据关联由独立产物说明。'
    provenance['coverage']['elaboratedInstances'] = 1
    provenance['coverage']['assessments'] = dict(portBits=dict(status='complete', expected=sum(p['width'] for p in module['interfaces']),
        detail='全部顶层端口随配置求值，内部连接缺口另记。', evidenceIds=['source_0']),
        behavior=dict(status='partial', expected=None, detail='比较三指针与状态深度寄存器的有限单步函数。', evidenceIds=['write_logic','read_logic','depth_logic']))
    provenance['unsupportedStructures'] += [dict(id='memory_words', kind='addressed_ram', moduleIds=['top'], category='unsupported',
        description=f'源码 mem[{1 << addr}×{dw}] 是真实地址化 RAM。当前模型不表达 RAM 字与按地址读写。管线首级的负载来源保留在源码证据。',
        evidenceIds=['address_logic','write_logic','read_logic'], targets=[dict(kind='local', moduleId='top', itemId='pipe_word0')]),
        dict(id='frame_replay', kind='ram_frame_replay', moduleIds=['top'], category='unsupported',
             description='当前回放无 RAM 地址、帧提交、回滚或丢弃语义。', evidenceIds=['write_logic','read_logic'])]

    def add(name, width, description, driver, evidence_id):
        state.append(dict(id=name, scope='top', name=PIN.get(name,name), width=width, description=description, driver=driver,
                          evidenceIds=[evidence_id]))

    def rule(name, width, description, source_text, branches, evidence_id, reset=True):
        reset_rule = dict(signal=endpoint('rst'), activeLevel='high', value=literal(width, 0)) if reset else None
        update = dict(reset=reset_rule, branches=[dict(id=i, condition=c, value=v) for i,c,v in branches], otherwise='hold')
        dependencies = [endpoint('rst')] if reset else []
        for _, cond, val in branches:
            dependencies.extend(reads(cond)+reads(val))
        add(name, width, description, dict(kind='register', inputs=dependencies, sourceText=source_text, update=update), evidence_id)

    def reference(name, width, description, text, evidence_id, inputs):
        add(name, width, description, dict(kind='register', inputs=inputs, sourceText=text), evidence_id)

    q = lambda n: signal(n, True)
    L = lambda n: endpoint(n, True)
    inv = lambda x: operator('!', x)
    rd, wr, commit = map(q, ('rd_ptr_reg','wr_ptr_reg','wr_ptr_commit_reg'))
    last, valid, user = map(signal, ('s_axis_tlast','s_axis_tvalid','s_axis_tuser'))
    is_full = lambda other: operator('==', wr, operator('^', other, literal(pw, 1 << addr)))
    full_attempt, increment = is_full(commit), operator('+', wr, literal(pw,1))
    ready = operator('||', inv(is_full(rd)), full_attempt) if frame else inv(is_full(rd))
    accepted = operator('&&', valid, ready)
    if frame:
        dropping = operator('||', full_attempt, q('drop_frame_reg'))
        retained = operator('&&', accepted, inv(dropping))
        bad_last = operator('&&', last, user)
        write = [('rollback_oversize', operator('&&', accepted, operator('&&',dropping,last)), commit),
                 ('rollback_bad', operator('&&',retained,bad_last), commit), ('store', retained, increment)]
        publish = operator('&&',retained,operator('&&',last,inv(user)))
    else:
        write, publish = [('store',accepted,increment)], accepted
    rule('wr_ptr_reg',pw,'当前 RAM 写指针，含地址回绕相位。','wr_ptr_reg <= wr_ptr_reg + 1 或回滚到提交指针',write,'write_logic')
    rule('wr_ptr_commit_reg',pw,'可读数据的提交边界。','wr_ptr_commit_reg <= wr_ptr_reg + 1',
         [('publish',publish,increment)],'write_logic')
    pipe_ready = operator('&&', signal('m_axis_tready'), inv(q('pause_q')))
    room = operator('||',pipe_ready,inv(operator('reduce_and',q('m_axis_tvalid_pipe_reg'))))
    rule('rd_ptr_reg',pw,'RAM 读入有效管线时前进。','rd_ptr_reg <= rd_ptr_reg + 1',
         [('read',operator('&&',room,operator('!=',rd,commit)),operator('+',rd,literal(pw,1)))],'read_logic')
    for dest, source in [('depth_reg',wr),('depth_commit_reg',commit)]:
        rule(dest,pw,'前一沿指针差形成深度状态。',f'{dest} <= pointer - rd_ptr_reg',
            [('sample',literal(1,1),operator('-',source,rd))],'depth_logic',False)
    reference('pause_q',1,'帧边界暂停状态。','pause_reg <= pause_req','pause_logic',[endpoint('pause_req'),endpoint('rst')])
    reference('drop_frame_reg',1,'超长帧等待 last 的丢弃状态。','drop_frame_reg <= 1 或 0','write_logic',
              [L('wr_ptr_reg'),L('wr_ptr_commit_reg'),endpoint('s_axis_tlast'),endpoint('rst')])
    reference('m_axis_tvalid_pipe_reg',2,'管线第 0、1 级的有效位。','m_axis_tvalid_pipe_reg[0:1] 在读入与移动时更新','read_logic',
              [L('rd_ptr_reg'),L('wr_ptr_commit_reg'),L('pause_q'),endpoint('m_axis_tready'),endpoint('rst')])
    reference('pipe_word0',dw,'RAM 读入的数据；实际存储数组见缺口。','m_axis_pipe_reg[0] <= mem[rd_ptr_reg[ADDR_WIDTH-1:0]]',
              'read_logic',[L('rd_ptr_reg'),L('m_axis_tvalid_pipe_reg'),L('pause_q'),endpoint('m_axis_tready')])
    reference('pipe_word1',dw,'出口前的 packed 数据寄存器。','m_axis_pipe_reg[1] <= m_axis_pipe_reg[0]',
              'read_logic',[L('pipe_word0'),L('m_axis_tvalid_pipe_reg'),L('pause_q'),endpoint('m_axis_tready')])

    def connect(src, port, bits=None, target_bits=None):
        links.append({'id': f'to_{port}', 'scope': 'top', 'from': endpoint(src, True, bits), 'to': endpoint(port, bits=target_bits)})

    def comb(port, width, value, source):
        name = f'{port}_logic'
        add(name,width,'端口组合来源。',dict(kind='comb',value=value),source)
        connect(name,port)

    bit = 0
    for field,width in fields.items():
        connect('pipe_word1',f'm_axis_{field}',(bit,bit+width-1))
        bit += width
    connect('pause_q','pause_ack')
    comb('s_axis_tready',1,ready,'address_logic')
    comb('m_axis_tvalid',1,operator('&&',signal('m_axis_tvalid_pipe_reg',True,(1,1)),inv(q('pause_q'))),'pause_logic')
    shift = keep.bit_length()-1
    for port,source in [('status_depth','depth_reg'),('status_depth_commit','depth_commit_reg')]:
        # Low zero bits already have explicit imported links.
        connect(source,port,target_bits=(shift,shift+pw-1))
    for flag in ('overflow', 'bad_frame', 'good_frame'):
        name = f'{flag}_reg'
        reference(name,1,'写侧逻辑产生的状态脉冲。',f'assign status_{flag} = {name}',
                  'write_logic',[endpoint('rst'), endpoint('s_axis_tlast'), endpoint('s_axis_tvalid')] if frame else [endpoint('rst')])
        connect(name,f'status_{flag}')
    return model


def state_specs(model):
    result = []
    for entry in model['localSignals']:
        update = entry['driver'].get('update')
        if not update:
            continue
        name = entry['id']
        signals = {e['interfaceId']: e for e in entry['driver']['inputs'] if e['interfaceId'] != name}
        result.append(dict(moduleId='top',localSignalId=name,state=PIN.get(name,name),clock='clk',signals=[
            dict(endpoint=e,pin=PIN.get(id_,id_) if e.get('local') else id_) for id_,e in signals.items()]))
    return result
