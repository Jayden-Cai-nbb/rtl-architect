module pipe_reg(input logic clk, rst, input logic [7:0] d, output logic [7:0] q);
  always_ff @(posedge clk) if (rst) q <= '0; else q <= d;
endmodule
module pipeline(input logic clk, rst, input logic [7:0] din, output wire [7:0] dout);
  wire [7:0] middle;
  pipe_reg first(clk, rst, din, middle);
  pipe_reg second(clk, rst, middle, dout);
endmodule
