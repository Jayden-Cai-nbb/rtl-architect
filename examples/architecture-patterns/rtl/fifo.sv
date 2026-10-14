// One-entry elastic FIFO; a consumed word can be replaced on the same edge.
module fifo(input wire clk, rst, s_valid, m_ready, input wire [7:0] s_data,
            output wire s_ready, m_valid, output wire [7:0] m_data);
  logic full;
  logic [7:0] data_q;
  wire accept = ~rst & (~full | m_ready);
  assign s_ready = accept;
  assign m_valid = ~rst & full;
  assign m_data = data_q;
  always_ff @(posedge clk) begin
    if (rst) begin full <= 1'b0; data_q <= '0; end
    else if (accept) begin
      full <= s_valid;
      if (s_valid) data_q <= s_data;
    end
  end
endmodule
