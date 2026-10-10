`timescale 1ns/1ps
module tb_tiny_stream;
  logic clk = 0;
  always #5 clk = ~clk;
  logic rst_n = 0;
  logic [7:0] s_data = 0, m_data;
  logic s_valid = 0, s_ready, m_valid, m_ready = 0;
  tiny_stream dut (.*);

  byte unsigned expected[$];
  int timestamps[$], fifo_times[$], add_times[$];
  int cycle = 0, accepted = 0, received = 0, cancelled = 0;
  int full_seen = 0, empty_seen = 0, simultaneous_seen = 0, full_pop_seen = 0;
  int stalled_seen = 0, overflow_seen = 0, min2_seen = 0, fifo_min1_seen = 0, add_min1_seen = 0;
  int output_streak = 0, max_output_streak = 0;
  bit input_stalled = 0, output_stalled = 0, fifo_stalled = 0;
  logic [7:0] prior_input, prior_output, prior_fifo;
  bit force_timeout;
  logic [31:0] rng = 32'hcafef00d;

  // Observe pre-NBA state at the sampling edge. All stimulus changes at negedge.
  always @(posedge clk) begin : scoreboard
    byte unsigned want;
    int timestamp;
    cycle = cycle + 1;
    if (!rst_n) begin
      if (s_ready || m_valid || dut.path.fifo.m_valid || dut.path.add.s_ready)
        $fatal(1, "RESET_GATING: valid/ready must be zero during reset");
      cancelled = cancelled + expected.size();
      expected.delete(); timestamps.delete(); fifo_times.delete(); add_times.delete();
      input_stalled = 0; output_stalled = 0; fifo_stalled = 0; output_streak = 0;
    end else begin
      if (input_stalled && (!s_valid || s_data !== prior_input)) $fatal(1, "SOURCE_HOLD violated");
      if (output_stalled && (!m_valid || m_data !== prior_output)) $fatal(1, "OUTPUT_HOLD violated");
      if (fifo_stalled && (!dut.path.mid_valid || dut.path.mid_data !== prior_fifo)) $fatal(1, "FIFO_HOLD violated");
      if (dut.path.fifo.count > 4) $fatal(1, "FIFO_COUNT outside 0..DEPTH");
      if (dut.path.fifo.count == 0) begin
        empty_seen++;
        if (dut.path.mid_valid) $fatal(1, "FIFO empty bypass is forbidden");
      end
      if (dut.path.fifo.count == 4) begin
        full_seen++;
        if (s_ready) $fatal(1, "FIFO full must not accept even if popping");
        if (dut.path.fifo.pop) full_pop_seen++;
      end
      if (dut.path.fifo.push && dut.path.fifo.pop) simultaneous_seen++;
      // Outputs checked before inputs: same-cycle fall-through cannot satisfy the queue.
      if (m_valid && m_ready) begin
        if (expected.size() == 0) $fatal(1, "UNEXPECTED_OUTPUT");
        want = expected.pop_front(); timestamp = timestamps.pop_front();
        if (m_data !== want) $fatal(1, "MISMATCH got=%0d expected=%0d cycle=%0d", m_data, want, cycle);
        if (cycle - timestamp < 2) $fatal(1, "PIPELINE_LATENCY below 2");
        if (cycle - timestamp == 2) min2_seen++;
        if (add_times.size() == 0) $fatal(1, "ADD output without accepted input");
        timestamp = add_times.pop_front();
        if (cycle - timestamp < 1) $fatal(1, "ADD_LATENCY below 1");
        if (cycle - timestamp == 1) add_min1_seen++;
        received++; output_streak++;
        if (output_streak > max_output_streak) max_output_streak = output_streak;
      end else output_streak = 0;
      if (dut.path.mid_valid && dut.path.mid_ready) begin
        if (fifo_times.size() == 0) $fatal(1, "FIFO output without accepted input");
        timestamp = fifo_times.pop_front();
        if (cycle - timestamp < 1) $fatal(1, "FIFO_LATENCY below 1");
        if (cycle - timestamp == 1) fifo_min1_seen++;
        add_times.push_back(cycle);
      end
      if (s_valid && s_ready) begin
        expected.push_back(8'(s_data + 8'd3)); timestamps.push_back(cycle); fifo_times.push_back(cycle);
        if (s_data >= 253) overflow_seen++;
        accepted++;
      end
      if (m_valid && !m_ready) stalled_seen++;
      input_stalled = s_valid && !s_ready; prior_input = s_data;
      output_stalled = m_valid && !m_ready; prior_output = m_data;
      fifo_stalled = dut.path.mid_valid && !dut.path.mid_ready; prior_fifo = dut.path.mid_data;
    end
    if (cycle >= 5000) $fatal(1, "TIMEOUT: scoreboard failed to drain");
  end

  task automatic drive(input bit valid, input byte unsigned data, input bit ready);
    @(negedge clk);
    rst_n = 1; m_ready = ready;
    if (!input_stalled) begin s_valid = valid; s_data = data; end
  endtask
  task automatic reset_inflight;
    @(negedge clk); rst_n = 0; s_valid = 0; m_ready = 0;
    repeat (2) @(negedge clk);
    rst_n = 1;
  endtask
  task automatic send(input byte unsigned data);
    @(negedge clk); rst_n = 1; s_valid = 1; s_data = data; m_ready = 1;
    do @(posedge clk); while (!s_ready);
    @(negedge clk); s_valid = 0;
  endtask
  task automatic drain;
    drive(0, 0, 1);
    while (expected.size() != 0 || s_valid) drive(0, 0, 1);
  endtask
  initial begin
    force_timeout = $test$plusargs("force_timeout");
    reset_inflight();
    if (force_timeout) begin
      repeat (20) drive(1, 8'hff, 0);
      forever drive(0, 0, 0); // Deliberately never drain: must terminate via $fatal TIMEOUT.
    end
    send(0); send(253); send(255); drain();
    // Initial empty, always-ready continuous transfer: observe 1/cycle steady throughput.
    for (int i = 0; i < 96; i++) drive(1, 8'(i), 1);
    drain();
    // Fill FIFO + elastic output, then release: full/pop excludes simultaneous push.
    for (int i = 0; i < 24; i++) drive(1, 8'(200+i), 0);
    for (int i = 0; i < 40; i++) drive(1, 8'(i+40), 1);
    drain();
    // Cancel actual queued transactions while output is blocked.
    repeat (16) drive(1, 8'hfd, 0);
    reset_inflight();
    for (int i = 0; i < 1600; i++) begin
      rng = rng ^ (rng << 13); rng = rng ^ (rng >> 17); rng = rng ^ (rng << 5);
      drive(rng[1:0] != 0, rng[15:8], rng[4:2] < 5);
      if (i == 777) reset_inflight();
    end
    drain();
    @(negedge clk);
    if (expected.size() != 0 || fifo_times.size() != 0 || add_times.size() != 0) $fatal(1, "INFLIGHT at finish");
    if (accepted != received + cancelled) $fatal(1, "ACCOUNTING conservation failed");
    if (!(full_seen > 0 && empty_seen > 0 && simultaneous_seen > 0 && full_pop_seen > 0 && stalled_seen > 0 && overflow_seen > 0 && cancelled > 0 && min2_seen > 0 && fifo_min1_seen > 0 && add_min1_seen > 0 && max_output_streak >= 16))
      $fatal(1, "COVERAGE missing required handshake scenario");
    $display("PASS fixture DATA_W=8 DEPTH=4 CONST=3 accepted=%0d received=%0d cancelled=%0d", accepted, received, cancelled);
    $display("COVERAGE full=%0d empty=%0d simultaneous=%0d full_pop=%0d stalled=%0d overflow=%0d min2=%0d fifo_min1=%0d add_min1=%0d max_streak=%0d", full_seen, empty_seen, simultaneous_seen, full_pop_seen, stalled_seen, overflow_seen, min2_seen, fifo_min1_seen, add_min1_seen, max_output_streak);
    $finish;
  end
endmodule
